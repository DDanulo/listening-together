import { describe, expect, it } from 'vitest'
import { ClockEstimator, MIN_SAMPLES, SAMPLE_WINDOW_MS, computeSample } from './clock'

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
    expect(estimator.offset()).toBeCloseTo(1000.1)
    expect(estimator.bestRtt()).toBe(20)
  })

  it('drops samples older than the window when new ones arrive', () => {
    const estimator = new ClockEstimator()
    estimator.add({ offset: 500, rtt: 5 }, 0)
    estimator.add({ offset: 1000, rtt: 50 }, SAMPLE_WINDOW_MS + 1)

    expect(estimator.sampleCount).toBe(1)
    expect(estimator.offset()).toBe(1000)
  })

  it('is not synced below the minimum number of samples', () => {
    const estimator = new ClockEstimator()
    expect(estimator.offset()).toBeNull()
    for (let i = 0; i < MIN_SAMPLES - 1; i++) estimator.add({ offset: 0, rtt: 10 }, i)
    expect(estimator.synced).toBe(false)
    estimator.add({ offset: 0, rtt: 10 }, 10)
    expect(estimator.synced).toBe(true)
  })
})
