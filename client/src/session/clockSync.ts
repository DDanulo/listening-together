import { looksDead } from '../net/reconnect'
import type { PingMessage, PongMessage } from '../protocol/types'
import { ClockEstimator, type ClockStrategy, computeSample } from '../sync/clock'

const BURST_SIZE = 10
const BURST_SPACING_MS = 50
const PERIODIC_SIZE = 3
const PERIODIC_INTERVAL_MS = 5_000

export interface ClockSyncEvents {
  send(ping: PingMessage): void
  /** A new sample changed the estimate. */
  update(): void
  /** Pings stopped being answered: the connection is dead even if the socket still looks open. */
  dead(): void
}

/**
 * Ping schedule from protocol §4: a burst on (re)connect, then a few pings every 5 s. The estimator outlives
 * connections: the offset belongs to the two clocks, so after a reconnect the old samples still apply.
 */
export class ClockSync {
  readonly estimator: ClockEstimator
  private readonly events: ClockSyncEvents
  private seq = 0
  private timeouts: number[] = []
  private interval: number | undefined
  /** Client time of the oldest ping sent since the last pong (liveness check). */
  private oldestUnansweredPingAt: number | null = null

  constructor(events: ClockSyncEvents, strategy: ClockStrategy = 'periodic') {
    this.events = events
    this.estimator = new ClockEstimator(strategy)
  }

  /** Starts pinging on a fresh connection. */
  start(): void {
    this.stop()
    this.burst(BURST_SIZE)
    this.interval = window.setInterval(() => {
      if (looksDead(this.oldestUnansweredPingAt, performance.now())) {
        this.events.dead()
        return
      }
      this.burst(PERIODIC_SIZE)
    }, PERIODIC_INTERVAL_MS)
  }

  /** Stops pinging (connection lost or left); keeps the estimate. */
  stop(): void {
    this.timeouts.forEach((id) => window.clearTimeout(id))
    this.timeouts = []
    window.clearInterval(this.interval)
    this.interval = undefined
    this.oldestUnansweredPingAt = null
  }

  handlePong(pong: PongMessage, receivedAt: number): void {
    this.oldestUnansweredPingAt = null
    this.estimator.add(computeSample(pong.t0, pong.t1, pong.t2, receivedAt), receivedAt)
    this.events.update()
  }

  /** Current serverTime − clientTime estimate, or null before the first sample. */
  offset(): number | null {
    return this.estimator.offset(performance.now())
  }

  /** Current server time estimate, or null before the first sample. */
  serverNow(): number | null {
    const now = performance.now()
    const offset = this.estimator.offset(now)
    return offset === null ? null : now + offset
  }

  private burst(count: number): void {
    for (let i = 0; i < count; i++) {
      this.timeouts.push(window.setTimeout(() => this.ping(), i * BURST_SPACING_MS))
    }
  }

  private ping(): void {
    const t0 = performance.now()
    this.oldestUnansweredPingAt ??= t0
    this.events.send({ type: 'ping', seq: ++this.seq, t0 })
  }
}
