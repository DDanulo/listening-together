import { AudioEngine } from '../audio/engine'
import { Connection, roomSocketUrl } from '../net/connection'
import {
  type Command,
  type DownloadStatus,
  type PlaybackState,
  type ServerMessage,
  type Track,
  CloseCode,
  PROTOCOL_VERSION,
} from '../protocol/types'
import { needsResync } from '../sync/drift'
import { type Segment, audiblePosition, expectedPosition, planTransition } from '../sync/playback'
import { ApiError, readDurationMs, uploadTrack } from './api'
import { clientId } from './clientId'
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
}

export class LiveRoomSession implements RoomSession {
  private view: RoomView
  private readonly listeners = new Set<() => void>()
  private readonly naive: boolean
  private connection: Connection | null = null
  private engine: AudioEngine | null = null
  private clock: ClockSync | null = null
  private statsTimer: number | undefined
  private timingTimer: number | undefined
  private driftMs: number | null = null
  private resyncs = 0
  /** Last timing measurement, with the segment it belongs to: only readings of the same audio may confirm. */
  private previousDrift: { segment: Segment; errorMs: number } | null = null
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
    this.view = {
      connection: 'idle',
      roomId,
      me: null,
      members: [],
      queue: [],
      playback: null,
      downloads: {},
      sync: { synced: false, offsetMs: null, bestRttMs: null, samples: 0, driftMs: null, resyncs: 0, lastResync: null },
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
    this.connection = new Connection(roomSocketUrl(this.view.roomId), {
      open: () => this.connection?.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientId: clientId(), name }),
      message: (message, receivedAt) => this.handle(message, receivedAt),
      close: (code, reason) => this.handleClose(code, reason),
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
        this.lastRev = message.room.playback.rev
        this.pendingApply = true
        this.update({
          connection: 'open',
          me: message.memberId,
          members: message.room.members,
          queue: message.room.queue,
          playback: message.room.playback,
        })
        this.startClockSync()
        this.downloadQueue()
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

  private handleClose(code: number, reason: string): void {
    // Rule 7: audio is local and keeps playing; the PoC has no reconnect yet.
    this.clock?.stop()
    window.clearInterval(this.statsTimer)
    this.connection = null
    let error = this.view.error
    if (code === CloseCode.ROOM_NOT_FOUND) {
      error = { code: 'ROOM_NOT_FOUND', message: 'This room does not exist' }
    } else if (code !== CloseCode.NORMAL && !EXPLAINED_CLOSES.has(code)) {
      // Replaces any older error still on screen: the disconnect is what matters now.
      error = { code: 'DISCONNECTED', message: reason || 'Connection lost' }
    }
    this.update({ connection: 'closed', error })
  }

  // ---------- clock ----------

  private startClockSync(): void {
    this.clock?.stop()
    this.clock = new ClockSync((ping) => this.connection?.send(ping), () => this.onClockUpdate())
    this.clock.start()
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
   * Measures the timing error of the playing audio and restarts it at the right position when it's off, e.g.
   * when the start was scheduled with a stale audio clock after the output had been idle (hard resync).
   */
  private checkTiming(): void {
    const engine = this.engine
    const state = this.view.playback
    const offset = this.clock?.estimator.offset()
    if (!engine || offset == null || state?.status !== 'playing') {
      this.previousDrift = null
      this.setDrift(null)
      return
    }
    const serverNow = performance.now() + offset
    // Only audio of the current state; a segment that is about to be stopped by a pending change is left alone.
    const segment = engine.segments.find((s) => s.rev === state.rev && s.startAt <= serverNow && s.stopAt === null)
    const errorMs = segment ? engine.timingErrorMs(segment, (serverTime) => serverTime - offset) : null
    this.setDrift(errorMs)
    const previous = segment && this.previousDrift?.segment === segment ? this.previousDrift.errorMs : null
    this.previousDrift = segment && errorMs !== null ? { segment, errorMs } : null
    if (segment && errorMs !== null && needsResync(errorMs, previous, performance.now() - this.lastResyncAt)) {
      this.lastResyncAt = performance.now()
      this.resyncs++
      this.previousDrift = null
      this.lastResync = { errorMs, timestampSource: engine.timestampSource }
      console.info(`Resync #${this.resyncs}: playback was ${errorMs.toFixed(1)} ms off`, {
        previousErrorMs: previous,
        timestampSource: engine.timestampSource,
        outputLatencyMs: engine.outputLatencyMs(),
        baseLatencyMs: engine.context.baseLatency * 1000,
      })
      engine.discard(segment)
      // No segment for the current state any more, so the planner starts it again at the correct position.
      this.applyPlayback()
      this.updateSync()
    }
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
