import { AudioEngine, type TimestampSource } from '../audio/engine'
import { Connection, roomSocketUrl } from '../net/connection'
import { PROTOCOL_VERSION } from '../protocol/types'
import { clientId } from './clientId'
import { ClockSync } from './clockSync'

const TICK_MS = 50
/** How far ahead clicks are handed to Web Audio. */
const LOOKAHEAD_MS = 300
const BEAT_MS = 1000

export interface MetronomeView {
  connection: 'idle' | 'connecting' | 'open' | 'closed'
  synced: boolean
  offsetMs: number | null
  bestRttMs: number | null
  samples: number
  /**
   * offset − performance.timeOrigin: the estimated server time minus the absolute (epoch) time. Tabs on the same
   * machine share one physical clock, so this must be equal in all of them (acceptance test A1).
   */
  clockCheckMs: number | null
  timestampSource: TimestampSource
  outputLatencyMs: number | null
}

/**
 * Debug tool (milestone M1): clicks at every whole second of server time, with a high click every 10 s.
 * Tests clock sync + scheduling in isolation, without tracks or the playback model.
 */
export class MetronomeSession {
  private engine: AudioEngine | null = null
  private connection: Connection | null = null
  private clock: ClockSync | null = null
  private ticker: number | undefined
  private nextBeat: number | null = null
  private connectionState: MetronomeView['connection'] = 'idle'

  /** Call from a click handler (unlocks audio). */
  start(roomId: string): void {
    this.stop()
    this.engine = new AudioEngine()
    void this.engine.unlock()
    this.connectionState = 'connecting'
    this.connection = new Connection(roomSocketUrl(roomId), {
      open: () => this.connection?.send({
        type: 'hello', protocolVersion: PROTOCOL_VERSION, clientId: clientId(), name: 'metronome',
      }),
      message: (message, receivedAt) => {
        if (message.type === 'welcome') {
          this.connectionState = 'open'
          this.clock = new ClockSync((ping) => this.connection?.send(ping), () => {})
          this.clock.start()
        } else if (message.type === 'pong') {
          this.clock?.handlePong(message, receivedAt)
        }
      },
      close: () => {
        this.connectionState = 'closed'
      },
    })
    this.ticker = window.setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    window.clearInterval(this.ticker)
    this.clock?.stop()
    this.connection?.close()
    this.engine?.close()
    this.engine = null
    this.connection = null
    this.clock = null
    this.nextBeat = null
    this.connectionState = 'idle'
  }

  snapshot(): MetronomeView {
    const estimator = this.clock?.estimator
    const offset = estimator?.offset() ?? null
    return {
      connection: this.connectionState,
      synced: estimator?.synced ?? false,
      offsetMs: offset,
      bestRttMs: estimator?.bestRtt() ?? null,
      samples: estimator?.sampleCount ?? 0,
      clockCheckMs: offset === null ? null : offset - performance.timeOrigin,
      timestampSource: this.engine?.timestampSource ?? 'currentTime',
      outputLatencyMs: this.engine?.outputLatencyMs() ?? null,
    }
  }

  private tick(): void {
    const offset = this.clock?.estimator.offset()
    if (!this.engine || !this.clock?.estimator.synced || offset == null) return
    const now = performance.now() + offset
    this.nextBeat ??= Math.ceil((now + LOOKAHEAD_MS) / BEAT_MS) * BEAT_MS
    while (this.nextBeat < now + LOOKAHEAD_MS) {
      this.engine.scheduleClick(this.nextBeat, (serverTime) => serverTime - offset, this.nextBeat % 10_000 === 0)
      this.nextBeat += BEAT_MS
    }
  }
}
