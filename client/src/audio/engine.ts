import type { Plan, Segment } from '../sync/playback'
import {
  type AudioClockPair, MIN_START_LEAD_S, type RateAnchor, catchUpStart, clientToAudioTime, isFresh, positionAtAudioTime,
  positionErrorMs,
} from './timeMapping'

interface ActiveSegment extends Segment {
  source: AudioBufferSourceNode
  /** Playback-rate history (drift nudging), oldest first; the first anchor is the start. */
  anchors: RateAnchor[]
}

export type TimestampSource = 'outputTimestamp' | 'currentTime'

/** Web Audio playback: decoding, sample-accurate scheduling and volume. All start/stop goes through here. */
export class AudioEngine {
  readonly context = new AudioContext({ latencyHint: 'interactive' })
  private readonly gain: GainNode
  private readonly decoded = new Map<string, AudioBuffer>()
  private active: ActiveSegment[] = []
  private lastTimestampSource: TimestampSource = 'currentTime'

  constructor() {
    this.gain = this.context.createGain()
    this.gain.connect(this.context.destination)
  }

  /** Must run inside a user gesture (autoplay policy; iOS requires it). */
  unlock(): Promise<void> {
    return this.context.resume()
  }

  setVolume(volume: number): void {
    this.gain.gain.value = Math.min(1, Math.max(0, volume))
  }

  get segments(): readonly Segment[] {
    return this.active
  }

  get timestampSource(): TimestampSource {
    return this.lastTimestampSource
  }

  outputLatencyMs(): number | null {
    const latency = this.context.outputLatency
    return typeof latency === 'number' ? latency * 1000 : null
  }

  isDecoded(trackId: string): boolean {
    return this.decoded.has(trackId)
  }

  decodedDurationMs(trackId: string): number | null {
    const buffer = this.decoded.get(trackId)
    return buffer ? buffer.duration * 1000 : null
  }

  /** Takes ownership of `encoded`: decodeAudioData detaches it, so the caller must not use it afterwards. */
  async decode(trackId: string, encoded: ArrayBuffer): Promise<void> {
    if (this.decoded.has(trackId)) return
    const buffer = await this.context.decodeAudioData(encoded)
    this.decoded.set(trackId, buffer)
  }

  /** Frees decoded audio except `keep` and what is playing: a decoded 4-minute track takes ~80 MB. */
  retainDecoded(keep: ReadonlySet<string>): void {
    for (const trackId of this.decoded.keys()) {
      if (!keep.has(trackId) && !this.active.some((s) => s.trackId === trackId)) {
        this.decoded.delete(trackId)
      }
    }
  }

  /**
   * Applies a plan. Returns false if the plan's start was skipped because the track isn't decoded yet;
   * the caller re-plans once it is.
   */
  apply(plan: Plan, toClientTime: (serverTime: number) => number): boolean {
    const pair = this.clockPair()
    const audioTime = (serverTime: number) => clientToAudioTime(toClientTime(serverTime), pair)

    for (const segment of plan.cancel) {
      const active = this.find(segment)
      if (active) {
        active.source.stop()
        this.remove(active)
      }
    }
    for (const { segment, at } of plan.stop) {
      const active = this.find(segment)
      if (active) {
        // A later stop() call replaces an earlier one, so the planner never asks for a later stop.
        active.source.stop(audioTime(at))
        active.stopAt = at
      }
    }

    if (!plan.start) return true
    const buffer = this.decoded.get(plan.start.trackId)
    if (!buffer) return false

    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    // The planner's margin is in server time; on the audio clock the start can still be in the past, because the
    // output-timestamp mapping lags currentTime by the output latency.
    const { when, position } = catchUpStart(audioTime(plan.start.startAt), plan.start.position,
      this.context.currentTime + MIN_START_LEAD_S)
    source.start(when, position / 1000)
    const segment: ActiveSegment = {
      ...plan.start,
      stopAt: null,
      source,
      anchors: [{ audioTime: when, position, rate: 1 }],
    }
    source.onended = () => this.remove(segment)
    this.active.push(segment)
    return true
  }

  /**
   * How far the segment's audio is behind the server timeline (ms; negative = ahead), measured at the moment the
   * sound leaves the speaker with a fresh clock reading. Null if the segment isn't playing.
   *
   * @param offset serverTime − clientTime
   */
  positionErrorMs(segment: Segment, offset: number): number | null {
    const active = this.find(segment)
    return active ? positionErrorMs(active, active.anchors, this.clockPair(), offset) : null
  }

  rateOf(segment: Segment): number {
    const anchors = this.find(segment)?.anchors
    return anchors ? anchors[anchors.length - 1].rate : 1
  }

  /**
   * Changes the playback speed of a segment from now on (drift nudging). The pitch changes along with it, which is
   * why the caller keeps the rate within a fraction of a percent.
   */
  setRate(segment: Segment, rate: number): void {
    const active = this.find(segment)
    if (!active) return
    const now = this.context.currentTime
    active.source.playbackRate.setValueAtTime(rate, now)
    active.anchors.push({ audioTime: now, position: positionAtAudioTime(active.anchors, now), rate })
  }

  /** Moves a segment's audio `ms` ahead (or behind, if negative) by playing at ±10 % speed for a moment. */
  shift(segment: Segment, ms: number): void {
    const active = this.find(segment)
    if (!active || ms === 0) return
    const start = this.context.currentTime + 0.05
    // At ±10 % speed, the track moves 0.1 ms per ms against real time: `ms` takes 10 × ms = ms / 100 seconds.
    const end = start + Math.abs(ms) / 100
    const rate = this.rateOf(segment)
    const fast = rate + (ms > 0 ? 0.1 : -0.1)
    active.source.playbackRate.setValueAtTime(fast, start)
    active.source.playbackRate.setValueAtTime(rate, end)
    active.anchors.push({ audioTime: start, position: positionAtAudioTime(active.anchors, start), rate: fast })
    active.anchors.push({ audioTime: end, position: positionAtAudioTime(active.anchors, end), rate })
  }

  /** Stops a segment immediately and forgets it (used before a resync restarts it). */
  discard(segment: Segment): void {
    const active = this.find(segment)
    if (active) {
      active.source.stop()
      this.remove(active)
    }
  }

  /** A short click at `serverTime`, for the metronome debug page. */
  scheduleClick(serverTime: number, toClientTime: (serverTime: number) => number, accent: boolean): void {
    const when = clientToAudioTime(toClientTime(serverTime), this.clockPair())
    const oscillator = this.context.createOscillator()
    const envelope = this.context.createGain()
    oscillator.frequency.value = accent ? 2000 : 1000
    envelope.gain.setValueAtTime(1, when)
    envelope.gain.exponentialRampToValueAtTime(0.001, when + 0.03)
    oscillator.connect(envelope).connect(this.gain)
    oscillator.start(when)
    oscillator.stop(when + 0.03)
  }

  close(): void {
    this.active.forEach((s) => s.source.stop())
    this.active = []
    void this.context.close()
  }

  /**
   * Simultaneous readings of the audio clock and performance.now(). getOutputTimestamp() refers to the moment a
   * sample leaves the speaker, so it includes (part of) the output latency; currentTime is the fallback.
   * After the output has been idle (e.g. a long pause), the timestamp can be stale; it's only used when fresh.
   */
  private clockPair(): AudioClockPair {
    const timestamp = this.context.getOutputTimestamp?.()
    if (timestamp?.contextTime !== undefined && timestamp.performanceTime !== undefined) {
      const pair = { contextTime: timestamp.contextTime, performanceTime: timestamp.performanceTime }
      if (isFresh(pair, performance.now())) {
        this.lastTimestampSource = 'outputTimestamp'
        return pair
      }
    }
    // currentTime is the audio being computed now; it reaches the speaker after the output latency. Shift it so
    // both sources describe the same moment (sound leaving the speaker); mixing them would look like drift.
    this.lastTimestampSource = 'currentTime'
    const latencySeconds = this.context.baseLatency + (this.context.outputLatency || 0)
    return { contextTime: this.context.currentTime, performanceTime: performance.now() + latencySeconds * 1000 }
  }

  private find(segment: Segment): ActiveSegment | undefined {
    return this.active.find((s) => s === segment)
  }

  private remove(segment: ActiveSegment): void {
    this.active = this.active.filter((s) => s !== segment)
    segment.source.disconnect()
  }
}
