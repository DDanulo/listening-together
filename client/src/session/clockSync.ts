import type { PingMessage, PongMessage } from '../protocol/types'
import { ClockEstimator, computeSample } from '../sync/clock'

const BURST_SIZE = 10
const BURST_SPACING_MS = 50
const PERIODIC_SIZE = 3
const PERIODIC_INTERVAL_MS = 5_000

/** Ping schedule from protocol §4: a burst on join, then a few pings every 5 s. */
export class ClockSync {
  readonly estimator = new ClockEstimator()
  private readonly send: (ping: PingMessage) => void
  private readonly onUpdate: () => void
  private seq = 0
  private timeouts: number[] = []
  private interval: number | undefined

  constructor(send: (ping: PingMessage) => void, onUpdate: () => void) {
    this.send = send
    this.onUpdate = onUpdate
  }

  start(): void {
    this.burst(BURST_SIZE)
    this.interval = window.setInterval(() => this.burst(PERIODIC_SIZE), PERIODIC_INTERVAL_MS)
  }

  stop(): void {
    this.timeouts.forEach((id) => window.clearTimeout(id))
    this.timeouts = []
    window.clearInterval(this.interval)
  }

  handlePong(pong: PongMessage, receivedAt: number): void {
    this.estimator.add(computeSample(pong.t0, pong.t1, pong.t2, receivedAt), receivedAt)
    this.onUpdate()
  }

  /** Current server time estimate, or null before the first sample. */
  serverNow(): number | null {
    const offset = this.estimator.offset()
    return offset === null ? null : performance.now() + offset
  }

  private burst(count: number): void {
    for (let i = 0; i < count; i++) {
      this.timeouts.push(window.setTimeout(() => this.ping(), i * BURST_SPACING_MS))
    }
  }

  private ping(): void {
    this.send({ type: 'ping', seq: ++this.seq, t0: performance.now() })
  }
}
