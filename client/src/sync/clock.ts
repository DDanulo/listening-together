// NTP-style clock offset estimation — see docs/protocol.md §4.

export interface ClockSample {
  /** serverTime ≈ clientTime + offset */
  offset: number
  /** Round-trip time excluding server processing. */
  rtt: number
}

/**
 * @param t0 client time when the ping was sent
 * @param t1 server time when the ping was received
 * @param t2 server time when the pong was sent
 * @param t3 client time when the pong was received
 */
export function computeSample(t0: number, t1: number, t2: number, t3: number): ClockSample {
  return {
    offset: ((t1 - t0) + (t2 - t3)) / 2,
    rtt: (t3 - t0) - (t2 - t1),
  }
}

/**
 * Which ping samples the offset is computed from (evaluation E2). The ping schedule is the same for all of them
 * (pings double as the connection's liveness check), so the strategies differ only in what they make of it.
 *
 * - `single`: the first sample only, like a naive "ask the server once" sync.
 * - `best`: the join burst only; median offset of its lowest-RTT samples. No updates afterwards.
 * - `periodic`: the default. Like `best`, over a sliding 30 s window that keeps getting new samples.
 * - `regression`: like `periodic` over 120 s, plus a linear fit of offset over time, which follows the rate at
 *   which the two clocks drift apart (tens of ppm) instead of lagging behind it.
 */
export type ClockStrategy = 'single' | 'best' | 'periodic' | 'regression'

export const CLOCK_STRATEGIES: readonly ClockStrategy[] = ['single', 'best', 'periodic', 'regression']

/** Samples needed before playback may be scheduled (`single`: 1). */
export const MIN_SAMPLES = 5
/** `periodic`: client and server clocks drift apart (~0.01–0.1 ms/s), so older samples go stale. */
export const SAMPLE_WINDOW_MS = 30_000
/** `regression`: a longer window, so the slope is measured over enough time to be accurate. */
export const REGRESSION_WINDOW_MS = 120_000
/** `best`: the join burst (protocol §4: 10 pings). */
export const BURST_SAMPLES = 10
/** Offset = median of this many lowest-RTT samples: robust to jitter spikes and single outliers. */
export const BEST_SAMPLES = 3
/** `regression`: the fit needs samples spread over at least this long; until then, fall back to `periodic`. */
export const MIN_REGRESSION_SPAN_MS = 10_000
/** `regression`: a steeper slope is a bad fit, not a real clock (quartz is within ~±100 ppm). */
export const MAX_SKEW = 500e-6

interface TimedSample extends ClockSample {
  clientTime: number
}

export class ClockEstimator {
  readonly strategy: ClockStrategy
  private samples: TimedSample[] = []

  constructor(strategy: ClockStrategy = 'periodic') {
    this.strategy = strategy
  }

  /** @param clientTime when the sample was taken (performance.now()) */
  add(sample: ClockSample, clientTime: number): void {
    if (this.frozen) return
    this.samples.push({ ...sample, clientTime })
    const window = this.strategy === 'regression' ? REGRESSION_WINDOW_MS : SAMPLE_WINDOW_MS
    if (this.strategy === 'periodic' || this.strategy === 'regression') {
      // Prune only when new samples arrive: while disconnected, the last estimate must stay usable.
      this.samples = this.samples.filter((s) => s.clientTime >= clientTime - window)
    }
  }

  get sampleCount(): number {
    return this.samples.length
  }

  get synced(): boolean {
    return this.samples.length >= (this.strategy === 'single' ? 1 : MIN_SAMPLES)
  }

  /** Estimated serverTime − clientTime at `clientNow`, or null without samples. */
  offset(clientNow: number): number | null {
    if (this.samples.length === 0) return null
    if (this.strategy === 'regression') {
      const fit = fitOffset(this.bestHalf())
      if (fit) return fit.offset + fit.skew * (clientNow - fit.clientTime)
    }
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, BEST_SAMPLES)
    return median(best.map((s) => s.offset))
  }

  bestRtt(): number | null {
    if (this.samples.length === 0) return null
    return Math.min(...this.samples.map((s) => s.rtt))
  }

  /** `regression`: the estimated drift between the clocks in ppm, or null until there is a fit. */
  skewPpm(): number | null {
    if (this.strategy !== 'regression') return null
    const fit = fitOffset(this.bestHalf())
    return fit ? fit.skew * 1e6 : null
  }

  /** `single` and `best` stop learning once they have what they use. */
  private get frozen(): boolean {
    return (this.strategy === 'single' && this.samples.length >= 1)
      || (this.strategy === 'best' && this.samples.length >= BURST_SAMPLES)
  }

  /** The lower-RTT half of the window (at least BEST_SAMPLES): high-RTT samples carry queueing delay. */
  private bestHalf(): TimedSample[] {
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt)
    return sorted.slice(0, Math.max(BEST_SAMPLES, Math.ceil(sorted.length / 2)))
  }
}

/**
 * Least-squares line through (clientTime, offset), or null if the samples span too little time to tell a slope
 * from noise. Returned as the offset at the samples' mean time plus the slope (ms per ms).
 */
export function fitOffset(
  samples: readonly { clientTime: number; offset: number }[],
): { clientTime: number; offset: number; skew: number } | null {
  if (samples.length < BEST_SAMPLES) return null
  const times = samples.map((s) => s.clientTime)
  if (Math.max(...times) - Math.min(...times) < MIN_REGRESSION_SPAN_MS) return null
  const meanTime = times.reduce((a, b) => a + b, 0) / samples.length
  const meanOffset = samples.reduce((a, s) => a + s.offset, 0) / samples.length
  let covariance = 0
  let variance = 0
  for (const s of samples) {
    covariance += (s.clientTime - meanTime) * (s.offset - meanOffset)
    variance += (s.clientTime - meanTime) ** 2
  }
  const skew = Math.max(-MAX_SKEW, Math.min(MAX_SKEW, covariance / variance))
  return { clientTime: meanTime, offset: meanOffset, skew }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
