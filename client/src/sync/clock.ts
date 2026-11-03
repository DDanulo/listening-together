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

/** Samples needed before playback may be scheduled. */
export const MIN_SAMPLES = 5
/** Client and server clocks drift apart (~0.01–0.1 ms/s), so older samples go stale. */
export const SAMPLE_WINDOW_MS = 30_000
/** Offset = median of this many lowest-RTT samples: robust to jitter spikes and single outliers. */
export const BEST_SAMPLES = 3

interface TimedSample extends ClockSample {
  clientTime: number
}

export class ClockEstimator {
  private samples: TimedSample[] = []

  /** @param clientTime when the sample was taken (performance.now()) */
  add(sample: ClockSample, clientTime: number): void {
    this.samples.push({ ...sample, clientTime })
    // Prune only when new samples arrive: while disconnected, the last estimate must stay usable.
    this.samples = this.samples.filter((s) => s.clientTime >= clientTime - SAMPLE_WINDOW_MS)
  }

  get sampleCount(): number {
    return this.samples.length
  }

  get synced(): boolean {
    return this.samples.length >= MIN_SAMPLES
  }

  /** Estimated serverTime − clientTime, or null without samples. */
  offset(): number | null {
    if (this.samples.length === 0) return null
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, BEST_SAMPLES)
    return median(best.map((s) => s.offset))
  }

  bestRtt(): number | null {
    if (this.samples.length === 0) return null
    return Math.min(...this.samples.map((s) => s.rtt))
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
