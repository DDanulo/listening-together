import type { Plan, Segment } from '../sync/playback'
import { type AudioClockPair, audioToClientTime, clientToAudioTime, isFresh } from './timeMapping'

interface ActiveSegment extends Segment {
  source: AudioBufferSourceNode
  /** AudioContext time (s) at which `position` plays. */
  audioStart: number
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
    const when = audioTime(plan.start.startAt)
    source.start(when, plan.start.position / 1000)
    // A start time in the past plays immediately, from the given offset.
    const segment: ActiveSegment = { ...plan.start, stopAt: null, source, audioStart: Math.max(when, this.context.currentTime) }
    source.onended = () => this.remove(segment)
    this.active.push(segment)
    return true
  }

  /**
   * How late the segment's audio comes out compared to when it should (ms, positive = late), measured with a
   * fresh clock reading. Null if the segment isn't playing.
   */
  timingErrorMs(segment: Segment, toClientTime: (serverTime: number) => number): number | null {
    const active = this.find(segment)
    if (!active) return null
    return audioToClientTime(active.audioStart, this.clockPair()) - toClientTime(active.startAt)
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
