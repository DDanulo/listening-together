import { AudioEngine } from '../audio/engine'
import { Connection, roomSocketUrl } from '../net/connection'
import {
  type Command,
  type DownloadStatus,
  type PlaybackState,
  type ServerMessage,
  type Track,
  type WelcomeMessage,
  CloseCode,
  PROTOCOL_VERSION,
} from '../protocol/types'
import { type DriftStrategy, NUDGE_READINGS, decideCorrection } from '../sync/drift'
import { type Segment, audiblePosition, expectedPosition, planTransition } from '../sync/playback'
import { ApiError, readDurationMs, uploadTrack } from './api'
import { clientId, resetClientId } from './clientId'
import { ClockSync } from './clockSync'
import type { RoomSession, RoomView } from './types'

const STATS_INTERVAL_MS = 2_000
const TIMING_CHECK_INTERVAL_MS = 1_000
/** Closes the server explains with an `error` message right before closing. */
const EXPLAINED_CLOSES = new Set<number>([
  CloseCode.PROTOCOL_ERROR, CloseCode.ROOM_NOT_FOUND, CloseCode.ROOM_FULL, CloseCode.RATE_LIMITED,
])

export interface SessionOptions {
  /** Ignore effectiveAt and act when messages arrive: the "before" baseline for the evaluation (?naive=1). */
  naive?: boolean
  /** How timing errors of the playing audio are corrected (evaluation E3; ?drift=off|resync|nudge). */
  drift?: DriftStrategy
}

/** Position errors kept per segment for the drift controller (it uses the last NUDGE_READINGS). */
const MAX_READINGS = NUDGE_READINGS

export class LiveRoomSession implements RoomSession {
  private view: RoomView
  private readonly listeners = new Set<() => void>()
  private readonly naive: boolean
  private readonly driftStrategy: DriftStrategy
  private connection: Connection | null = null
  private engine: AudioEngine | null = null
  private clock: ClockSync | null = null
  private statsTimer: number | undefined
  private timingTimer: number | undefined
  private driftMs: number | null = null
  private resyncs = 0
  /** Recent position errors of the playing segment: only readings of the same audio may confirm each other. */
  private readings: { segment: Segment; errorsMs: number[] } | null = null
  private playbackRate = 1
  private lastResync: RoomView['sync']['lastResync'] = null
  private lastResyncAt = -Infinity
  private lastRev = -1
  /** A state arrived before the clock was synced; apply it once it is (late join). */
  private pendingApply = false
  /** Proactive downloads; they only fill the browser's HTTP cache (see prefetch). */
  private readonly prefetched = new Map<string, Promise<void>>()
  private readonly decoding = new Map<string, Promise<void>>()

  constructor(roomId: string, options: SessionOptions = {}) {
    this.naive = options.naive ?? false
    this.driftStrategy = options.drift ?? 'nudge'
    this.view = {
      connection: 'idle',
      roomId,
      me: null,
      members: [],
      queue: [],
      playback: null,
      downloads: {},
      reconnect: null,
      sync: {
        synced: false, offsetMs: null, bestRttMs: null, samples: 0, driftMs: null, resyncs: 0, lastResync: null,
        driftStrategy: options.drift ?? 'nudge', playbackRate: 1,
      },
      audio: { timestampSource: 'currentTime', outputLatencyMs: null },
      error: null,
    }
  }

  getSnapshot = (): RoomView => this.view

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async join(name: string): Promise<void> {
    if (this.connection) return
    // A retry after being refused (e.g. room full) starts from scratch.
    window.clearInterval(this.timingTimer)
    this.engine?.close()
    // Created synchronously, still inside the click handler that called join().
    this.engine = new AudioEngine()
    const unlocked = this.engine.unlock()
    // Keeps running while disconnected: audio is local and the last clock estimate stays valid (rule 7).
    this.timingTimer = window.setInterval(() => this.checkTiming(), TIMING_CHECK_INTERVAL_MS)
    this.update({ connection: 'connecting', error: null })
    // One clock for the whole visit: it keeps its estimate across reconnects.
    this.clock ??= new ClockSync({
      send: (ping) => this.connection?.send(ping),
      update: () => this.onClockUpdate(),
      dead: () => this.connection?.reconnect('No answer to pings'),
    })
    this.connection = new Connection(roomSocketUrl(this.view.roomId), {
      open: () => this.connection?.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientId: clientId(), name }),
      message: (message, receivedAt) => this.handle(message, receivedAt),
      close: (code, reason, retryInMs) => this.handleClose(code, reason, retryInMs),
    })
    await unlocked
  }

  command(command: Command): void {
    this.connection?.send({ type: 'command', ...command })
  }

  async uploadTrack(file: File): Promise<void> {
    const me = this.view.me
    if (!me) throw new ApiError('NOT_JOINED', 'Join the room first', 0)
    let durationMs = await readDurationMs(file)
    if (Number.isNaN(durationMs)) {
      // Some formats don't expose a duration as metadata: decode once to measure it.
      const buffer = await this.engine?.context.decodeAudioData(await file.arrayBuffer())
      if (!buffer) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'This browser cannot read the file', 0)
      durationMs = buffer.duration * 1000
    }
    await uploadTrack(this.view.roomId, me, file, durationMs)
  }

  setVolume(volume: number): void {
    this.engine?.setVolume(volume)
  }

  getServerTime(): number | null {
    return this.clock?.serverNow() ?? null
  }

  getPositionMs(): number | null {
    const now = this.getServerTime()
    const state = this.view.playback
    if (now === null || !state || state.status === 'stopped') return null
    const duration = this.trackOf(state)?.durationMs ?? Infinity
    const audible = this.engine ? audiblePosition(this.engine.segments, now) : null
    const position = audible ?? (state.status === 'playing' ? expectedPosition(state, now) : state.position)
    return Math.min(duration, Math.max(0, position))
  }

  /**
   * Development aid (verifying drift correction): shifts the playing audio by `ms` (positive = ahead) by briefly
   * playing at ±10 % speed. The shift is a real timing error that the drift correction then has to remove.
   */
  debugShiftMs(ms: number): void {
    const state = this.view.playback
    const segment = this.engine?.segments.find((s) => s.rev === state?.rev && s.stopAt === null)
    if (segment) this.engine?.shift(segment, ms)
  }

  dismissError(): void {
    this.update({ error: null })
  }

  leave(): void {
    this.clock?.stop()
    window.clearInterval(this.statsTimer)
    window.clearInterval(this.timingTimer)
    this.connection?.close()
    this.engine?.close()
    this.connection = null
    this.engine = null
  }

  // ---------- incoming messages ----------

  private handle(message: ServerMessage, receivedAt: number): void {
    switch (message.type) {
      case 'pong':
        this.clock?.handlePong(message, receivedAt)
        break
      case 'welcome':
        this.handleWelcome(message)
        break
      case 'members':
        this.update({ members: message.members })
        break
      case 'queue':
        this.update({ queue: message.tracks })
        this.forgetRemovedTracks()
        this.downloadQueue()
        // A track added after the current one must be decoded before auto-advance reaches it (gapless).
        if (this.view.playback) this.prepareUpcoming(this.view.playback)
        break
      case 'playback':
        // Rule 5: never apply a state older than the one already applied.
        if (message.state.rev <= this.lastRev) return
        this.lastRev = message.state.rev
        this.update({ playback: message.state })
        this.pendingApply = true
        this.applyPlayback()
        break
      case 'error':
        this.update({ error: { code: message.code, message: message.message } })
        break
      default:
        console.warn('Ignoring unknown message', message)
    }
  }

  /** First join or a reconnect: the snapshot replaces what we knew, except for an older playback state. */
  private handleWelcome(message: WelcomeMessage): void {
    const reconnected = this.view.me !== null
    const { playback } = message.room
    // Rule 5 also across reconnects: a state we already applied (or a newer one) must not be applied again.
    const newer = playback.rev > this.lastRev
    if (newer) {
      this.lastRev = playback.rev
      this.pendingApply = true
    }
    this.update({
      connection: 'open',
      reconnect: null,
      me: message.memberId,
      members: message.room.members,
      queue: message.room.queue,
      ...(newer ? { playback } : {}),
      // A disconnect error is resolved now; anything else stays on screen.
      error: this.view.error?.code === 'DISCONNECTED' ? null : this.view.error,
    })
    this.startClockSync()
    this.forgetRemovedTracks()
    if (reconnected) {
      // trackStatus messages sent while the socket was down were lost.
      for (const [trackId, status] of Object.entries(this.view.downloads)) {
        this.connection?.send({ type: 'trackStatus', trackId, status })
      }
      // The clock is still synced: apply a state that changed while we were away right now.
      if (this.pendingApply) this.applyPlayback()
    }
    this.downloadQueue()
    if (this.view.playback) this.prepareUpcoming(this.view.playback)
  }

  private handleClose(code: number, reason: string, retryInMs: number | null): void {
    // Rule 7: audio is local and keeps playing on the last state and clock estimate while we reconnect.
    this.clock?.stop()
    window.clearInterval(this.statsTimer)
    if (code === CloseCode.REPLACED) {
      // Another tab took our clientId (a duplicated tab shares sessionStorage): continue as a new member.
      resetClientId()
    }
    if (retryInMs !== null) {
      this.update({
        connection: 'reconnecting',
        reconnect: { attempt: (this.view.reconnect?.attempt ?? 0) + 1, retryAt: performance.now() + retryInMs },
      })
      return
    }
    this.connection = null
    let error = this.view.error
    if (code === CloseCode.ROOM_NOT_FOUND) {
      error = { code: 'ROOM_NOT_FOUND', message: 'This room does not exist' }
    } else if (code !== CloseCode.NORMAL && !EXPLAINED_CLOSES.has(code)) {
      // Replaces any older error still on screen: the disconnect is what matters now.
      error = { code: 'DISCONNECTED', message: reason || 'Connection lost' }
    }
    this.update({ connection: 'closed', reconnect: null, error })
  }

  // ---------- clock ----------

  private startClockSync(): void {
    this.clock?.start()
    window.clearInterval(this.statsTimer)
    this.statsTimer = window.setInterval(() => this.sendStats(), STATS_INTERVAL_MS)
  }

  private onClockUpdate(): void {
    this.updateSync()
    if (this.pendingApply) this.applyPlayback()
  }

  private updateSync(): void {
    const estimator = this.clock?.estimator
    this.update({
      sync: {
        synced: estimator?.synced ?? false,
        offsetMs: estimator?.offset() ?? null,
        bestRttMs: estimator?.bestRtt() ?? null,
        samples: estimator?.sampleCount ?? 0,
        driftMs: this.driftMs,
        resyncs: this.resyncs,
        lastResync: this.lastResync,
        driftStrategy: this.driftStrategy,
        playbackRate: this.playbackRate,
      },
    })
  }

  private sendStats(): void {
    const estimator = this.clock?.estimator
    const offsetMs = estimator?.offset()
    const rttMs = estimator?.bestRtt()
    if (!estimator?.synced || offsetMs == null || rttMs == null) return
    this.connection?.send({
      type: 'stats',
      offsetMs,
      rttMs,
      driftMs: this.driftMs,
      outputLatencyMs: this.engine?.outputLatencyMs() ?? null,
    })
  }

  // ---------- playback ----------

  private applyPlayback(): void {
    const engine = this.engine
    const state = this.view.playback
    const offset = this.clock?.estimator.offset()
    if (!engine || !state || !this.clock?.estimator.synced || offset == null) return
    this.pendingApply = false

    const serverNow = performance.now() + offset
    const effective: PlaybackState = this.naive ? { ...state, effectiveAt: serverNow } : state
    const track = this.trackOf(state)
    const plan = planTransition(engine.segments, effective, serverNow, track?.durationMs ?? null)
    const started = engine.apply(plan, (serverTime) => serverTime - offset)

    if (plan.start && !started) {
      // Not decoded yet: start late as soon as it is.
      this.decode(plan.start.trackId).then(() => this.applyPlayback(), () => {})
    }
    this.prepareUpcoming(state)
    this.update({ audio: { timestampSource: engine.timestampSource, outputLatencyMs: engine.outputLatencyMs() } })
  }

  /**
   * Measures how far the playing audio is off the server timeline and corrects it with the drift strategy: by
   * nudging the playback rate, or by restarting at the right position (hard resync). Errors come from the clock
   * offset estimate improving, the audio clock running at a slightly different speed than the system clock, and
   * starts scheduled with a stale audio clock after the output had been idle.
   */
  private checkTiming(): void {
    const engine = this.engine
    const state = this.view.playback
    const offset = this.clock?.estimator.offset()
    if (!engine || offset == null || state?.status !== 'playing') {
      this.readings = null
      this.setDrift(null)
      this.setPlaybackRate(1)
      return
    }
    const serverNow = performance.now() + offset
    // Only audio of the current state; a segment that is about to be stopped by a pending change is left alone.
    const segment = engine.segments.find((s) => s.rev === state.rev && s.startAt <= serverNow && s.stopAt === null)
    const errorMs = segment ? engine.positionErrorMs(segment, offset) : null
    this.setDrift(errorMs)
    if (!segment || errorMs === null) {
      this.readings = null
      this.setPlaybackRate(1)
      return
    }
    if (this.readings?.segment !== segment) this.readings = { segment, errorsMs: [] }
    const errorsMs = this.readings.errorsMs
    errorsMs.push(errorMs)
    if (errorsMs.length > MAX_READINGS) errorsMs.shift()

    const rate = engine.rateOf(segment)
    const correction = decideCorrection(this.driftStrategy, errorsMs, rate, performance.now() - this.lastResyncAt)
    if (correction.kind === 'rate') {
      engine.setRate(segment, correction.rate)
    } else if (correction.kind === 'resync') {
      this.lastResyncAt = performance.now()
      this.resyncs++
      this.readings = null
      this.lastResync = { errorMs, timestampSource: engine.timestampSource }
      console.info(`Resync #${this.resyncs}: playback was ${errorMs.toFixed(1)} ms off`, {
        previousErrorsMs: errorsMs.slice(0, -1),
        timestampSource: engine.timestampSource,
        outputLatencyMs: engine.outputLatencyMs(),
        baseLatencyMs: engine.context.baseLatency * 1000,
      })
      engine.discard(segment)
      // No segment for the current state any more, so the planner starts it again at the correct position.
      this.applyPlayback()
      this.updateSync()
    }
    // A discarded segment reports rate 1, like the fresh one replacing it.
    this.setPlaybackRate(engine.rateOf(segment))
  }

  private setPlaybackRate(rate: number): void {
    if (rate === this.playbackRate) return
    this.playbackRate = rate
    this.updateSync()
  }

  private setDrift(driftMs: number | null): void {
    if (driftMs === this.driftMs) return
    this.driftMs = driftMs
    this.updateSync()
  }

  /** Decode the current and next track (gapless auto-advance); free the rest. */
  private prepareUpcoming(state: PlaybackState): void {
    const queue = this.view.queue
    const index = queue.findIndex((t) => t.trackId === state.trackId)
    const keep = new Set<string>()
    if (index >= 0) keep.add(queue[index].trackId)
    if (index + 1 < queue.length) keep.add(queue[index + 1].trackId)
    this.engine?.retainDecoded(keep)
    keep.forEach((trackId) => this.decode(trackId).catch(() => {}))
  }

  private trackOf(state: PlaybackState): Track | undefined {
    return this.view.queue.find((t) => t.trackId === state.trackId)
  }

  // ---------- downloads ----------

  private downloadQueue(): void {
    // Current track first, then the rest in queue order.
    const current = this.view.playback?.trackId
    const ordered = [...this.view.queue].sort((a, b) => Number(b.trackId === current) - Number(a.trackId === current))
    ordered.reduce<Promise<unknown>>((previous, track) => previous.then(() => this.prefetch(track).catch(() => {})),
      Promise.resolve())
  }

  /**
   * Downloads a track ahead of time into the browser's HTTP cache (track files are immutable and cacheable)
   * without keeping it in memory: a room can hold 30 tracks of up to 50 MB, which would kill a phone's tab.
   * Decoding fetches the file again, normally straight from the cache.
   */
  private prefetch(track: Track): Promise<void> {
    let promise = this.prefetched.get(track.trackId)
    if (!promise) {
      this.setDownload(track.trackId, 'downloading')
      promise = fetch(track.url).then(async (response) => {
        if (!response.ok) throw new Error(`Download failed: ${response.status}`)
        // Read and discard: the body lands in the HTTP cache, not in this tab's memory.
        if (response.body) await response.body.pipeTo(new WritableStream())
        else await response.arrayBuffer()
      })
      promise.then(() => this.setDownload(track.trackId, 'ready'), () => {
        this.prefetched.delete(track.trackId)
        this.setDownload(track.trackId, 'error')
      })
      this.prefetched.set(track.trackId, promise)
    }
    return promise
  }

  /** Drops bookkeeping for tracks that left the queue, so nothing about them lingers or gets reported. */
  private forgetRemovedTracks(): void {
    const inQueue = new Set(this.view.queue.map((t) => t.trackId))
    for (const trackId of this.prefetched.keys()) {
      if (!inQueue.has(trackId)) this.prefetched.delete(trackId)
    }
    const downloads = Object.fromEntries(Object.entries(this.view.downloads).filter(([id]) => inQueue.has(id)))
    this.update({ downloads })
  }

  private decode(trackId: string): Promise<void> {
    const engine = this.engine
    const track = this.view.queue.find((t) => t.trackId === trackId)
    if (!engine || !track) return Promise.reject(new Error('Unknown track'))
    if (engine.isDecoded(trackId)) return Promise.resolve()
    let promise = this.decoding.get(trackId)
    if (!promise) {
      promise = fetch(track.url)
        .then((response) => {
          if (!response.ok) throw new Error(`Download failed: ${response.status}`)
          return response.arrayBuffer()
        })
        .then((encoded) => engine.decode(trackId, encoded))
        .then(() => {
          if (this.view.downloads[trackId] !== 'ready') this.setDownload(trackId, 'ready')
        })
        .catch((error: unknown) => {
          this.setDownload(trackId, 'error')
          throw error
        })
        .finally(() => this.decoding.delete(trackId))
      this.decoding.set(trackId, promise)
    }
    return promise
  }

  private setDownload(trackId: string, status: DownloadStatus): void {
    // A track removed while it was downloading: the server no longer knows it (it would answer TRACK_NOT_FOUND).
    if (!this.view.queue.some((t) => t.trackId === trackId)) return
    this.update({ downloads: { ...this.view.downloads, [trackId]: status } })
    this.connection?.send({ type: 'trackStatus', trackId, status })
  }

  private update(patch: Partial<RoomView>): void {
    this.view = { ...this.view, ...patch }
    this.listeners.forEach((listener) => listener())
  }
}
