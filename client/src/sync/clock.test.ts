import { describe, expect, it } from 'vitest'
import {
  BURST_SAMPLES, ClockEstimator, MAX_SKEW, MIN_SAMPLES, SAMPLE_WINDOW_MS, computeSample, fitOffset,
} from './clock'

describe('computeSample', () => {
  it('recovers the offset exactly when network delay is symmetric', () => {
    // server clock is 1000 ms ahead; 20 ms each way; 5 ms server processing
    const offset = 1000
    const t0 = 0
    const t1 = t0 + 20 + offset
    const t2 = t1 + 5
    const t3 = t2 - offset + 20

    const sample = computeSample(t0, t1, t2, t3)

    expect(sample.offset).toBeCloseTo(1000)
    expect(sample.rtt).toBeCloseTo(40)
  })

  it('is off by half the asymmetry when delay is asymmetric', () => {
    // 10 ms there, 50 ms back → error of (10 - 50) / 2 = -20 ms
    const offset = 1000
    const t0 = 0
    const t1 = t0 + 10 + offset
    const t2 = t1
    const t3 = t2 - offset + 50

    const sample = computeSample(t0, t1, t2, t3)

    expect(sample.offset).toBeCloseTo(980)
    expect(sample.rtt).toBeCloseTo(60)
  })
})

describe('ClockEstimator', () => {
  it('ignores jitter spikes by using the lowest-RTT samples', () => {
    const estimator = new ClockEstimator()
    // true offset 1000; good samples have small errors, two spikes are way off
    const good = [1000.4, 999.8, 1000.1, 1000.6, 999.5, 1000.9, 999.2, 1001.0, 1000.2, 999.9]
    good.forEach((offset, i) => estimator.add({ offset, rtt: 20 + i * 0.5 }, i * 50))
    estimator.add({ offset: 1150, rtt: 300 }, 600)
    estimator.add({ offset: 850, rtt: 310 }, 650)

    // lowest RTTs are the first three good samples: median of 1000.4, 999.8, 1000.1
    expect(estimator.offset(700)).toBeCloseTo(1000.1)
    expect(estimator.bestRtt()).toBe(20)
  })

  it('drops samples older than the window when new ones arrive', () => {
    const estimator = new ClockEstimator()
    estimator.add({ offset: 500, rtt: 5 }, 0)
    estimator.add({ offset: 1000, rtt: 50 }, SAMPLE_WINDOW_MS + 1)

    expect(estimator.sampleCount).toBe(1)
    expect(estimator.offset(SAMPLE_WINDOW_MS + 1)).toBe(1000)
  })

  it('is not synced below the minimum number of samples', () => {
    const estimator = new ClockEstimator()
    expect(estimator.offset(0)).toBeNull()
    for (let i = 0; i < MIN_SAMPLES - 1; i++) estimator.add({ offset: 0, rtt: 10 }, i)
    expect(estimator.synced).toBe(false)
    estimator.add({ offset: 0, rtt: 10 }, 10)
    expect(estimator.synced).toBe(true)
  })
})

describe('ClockEstimator strategies', () => {
  it('"single" uses the first sample only and is synced right away', () => {
    const estimator = new ClockEstimator('single')
    estimator.add({ offset: 1030, rtt: 80 }, 0)
    estimator.add({ offset: 1000, rtt: 10 }, 50)

    expect(estimator.synced).toBe(true)
    expect(estimator.sampleCount).toBe(1)
    expect(estimator.offset(60_000)).toBe(1030)
  })

  it('"best" uses the join burst and ignores later samples', () => {
    const estimator = new ClockEstimator('best')
    for (let i = 0; i < BURST_SAMPLES; i++) estimator.add({ offset: 1000 + i, rtt: 20 + i }, i * 50)
    estimator.add({ offset: 2000, rtt: 1 }, 10_000)

    expect(estimator.sampleCount).toBe(BURST_SAMPLES)
    expect(estimator.offset(10_000)).toBe(1001) // median of the 3 lowest-RTT: 1000, 1001, 1002
  })

  it('"best" never drops its burst, however old', () => {
    const estimator = new ClockEstimator('best')
    for (let i = 0; i < BURST_SAMPLES; i++) estimator.add({ offset: 1000, rtt: 20 }, i * 50)
    expect(estimator.offset(10 * SAMPLE_WINDOW_MS)).toBe(1000)
  })

  it('"regression" extrapolates a drifting offset', () => {
    // the offset grows 50 ppm: 0.05 ms per second; samples every 5 s for 60 s
    const estimator = new ClockEstimator('regression')
    for (let t = 0; t <= 60_000; t += 5_000) estimator.add({ offset: 1000 + t * 50e-6, rtt: 20 }, t)

    expect(estimator.skewPpm()).toBeCloseTo(50)
    // 30 s after the last sample: 1000 + 90 000 × 50e-6 = 1004.5 (periodic would still say ~1000.1)
    expect(estimator.offset(90_000)).toBeCloseTo(1004.5)
  })

  it('"regression" falls back to the median until the samples span 10 s', () => {
    const estimator = new ClockEstimator('regression')
    for (let i = 0; i < 10; i++) estimator.add({ offset: 1000 + i, rtt: 20 + i }, i * 50)
    expect(estimator.skewPpm()).toBeNull()
    expect(estimator.offset(500)).toBe(1001)
  })
})

describe('fitOffset', () => {
  it('fits a line through the samples', () => {
    const fit = fitOffset([
      { clientTime: 0, offset: 10 },
      { clientTime: 10_000, offset: 11 },
      { clientTime: 20_000, offset: 12 },
    ])
    expect(fit?.clientTime).toBe(10_000)
    expect(fit?.offset).toBeCloseTo(11)
    expect(fit?.skew).toBeCloseTo(1e-4)
  })

  it('clamps an implausible slope', () => {
    const fit = fitOffset([
      { clientTime: 0, offset: 0 },
      { clientTime: 5_000, offset: 50 },
      { clientTime: 10_000, offset: 100 },
    ])
    expect(fit?.skew).toBe(MAX_SKEW)
  })
})
