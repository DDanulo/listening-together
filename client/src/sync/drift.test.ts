import { describe, expect, it } from 'vitest'
import {
  NUDGE_MAX_RATE_DEVIATION, RESYNC_COOLDOWN_MS, RESYNC_THRESHOLD_MS, decideCorrection, estimateErrorMs, needsResync,
  nudgeRate,
} from './drift'

const over = RESYNC_THRESHOLD_MS + 1

describe('needsResync', () => {
  it('resyncs when two consecutive measurements exceed the threshold in the same direction', () => {
    expect(needsResync(over, over + 5, Infinity)).toBe(true)
    expect(needsResync(-1500, -1480, Infinity)).toBe(true)
  })

  it('ignores a single outlier', () => {
    expect(needsResync(over, null, Infinity)).toBe(false)
    expect(needsResync(over, 2, Infinity)).toBe(false)
    expect(needsResync(2, over, Infinity)).toBe(false)
  })

  it('ignores measurements that disagree in direction', () => {
    expect(needsResync(over, -over, Infinity)).toBe(false)
  })

  it('tolerates errors up to the threshold', () => {
    expect(needsResync(RESYNC_THRESHOLD_MS, RESYNC_THRESHOLD_MS, Infinity)).toBe(false)
  })

  it('waits for the cooldown between resyncs', () => {
    expect(needsResync(500, 500, RESYNC_COOLDOWN_MS - 1)).toBe(false)
    expect(needsResync(500, 500, RESYNC_COOLDOWN_MS)).toBe(true)
  })
})

/** Readings without any nudging so far. */
const plain = (...errors: number[]) => errors.map((errorMs) => ({ errorMs, nudgedMs: 0 }))

describe('estimateErrorMs', () => {
  it('averages the readings without the extremes', () => {
    expect(estimateErrorMs(plain(2, 3, 30, 1, 2), 0)).toBeCloseTo(7 / 3) // drops 1 and 30 → mean of 2, 2, 3
  })

  it('projects readings taken before nudging moved the audio', () => {
    // 6 ms behind, then nudging moved the audio 4 ms ahead: all readings say "2 ms behind now"
    const readings = [
      { errorMs: 6, nudgedMs: 0 },
      { errorMs: 5, nudgedMs: 1 },
      { errorMs: 4, nudgedMs: 2 },
      { errorMs: 3, nudgedMs: 3 },
    ]
    expect(estimateErrorMs(readings, 4)).toBeCloseTo(2)
  })

  it('uses the last 8 readings', () => {
    expect(estimateErrorMs(plain(100, 100, 5, 5, 5, 5, 5, 5, 5, 5), 0)).toBeCloseTo(5)
  })

  it('is null without readings', () => {
    expect(estimateErrorMs([], 0)).toBeNull()
  })
})

describe('decideCorrection', () => {
  it('never corrects with the "off" strategy', () => {
    expect(decideCorrection('off', plain(500, 500, 500), 1, 0, Infinity)).toEqual({ kind: 'none' })
  })

  it('"resync" restarts on two confirming readings over 20 ms and ignores smaller errors', () => {
    expect(decideCorrection('resync', plain(25, 30), 1, 0, Infinity)).toEqual({ kind: 'resync' })
    expect(decideCorrection('resync', plain(15, 18, 19), 1, 0, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" leaves errors under 3 ms alone', () => {
    expect(decideCorrection('nudge', plain(2, -1, 2.5, 4, 1), 1, 0, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" speeds up a device that is behind and slows down one that is ahead', () => {
    // trimmed mean of 18, 20, 22, 19, 25 (drop 18 and 25) = 20.33 ms → +0.2 %
    expect(decideCorrection('nudge', plain(18, 20, 22, 19, 25), 1, 0, Infinity)).toEqual({ kind: 'rate', rate: 1.00203 })
    expect(decideCorrection('nudge', plain(-10, -10, -10), 1, 0, Infinity)).toEqual({ kind: 'rate', rate: 0.999 })
  })

  it('"nudge" ignores the measurement noise seen on Chrome/Linux (std ≈ 1.5 ms around a true +1.9 ms)', () => {
    const noisy = plain(-0.14, 3.22, 4.08, 0, 1.86, 1.54, 2.04, 2.66)
    expect(decideCorrection('nudge', noisy, 1, 0, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" needs three readings before acting', () => {
    expect(decideCorrection('nudge', plain(20, 20), 1, 0, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" stops once its own nudging has removed the error, without waiting for new readings', () => {
    // 10 ms behind, and nudging has since moved the audio 9.5 ms ahead: 0.5 ms left → back to normal speed
    expect(decideCorrection('nudge', plain(10, 10, 10), 1.001, 9.5, Infinity)).toEqual({ kind: 'rate', rate: 1 })
  })

  it('"nudge" keeps nudging down to 1 ms (hysteresis)', () => {
    expect(decideCorrection('nudge', plain(2, 2, 2), 1.002, 0, Infinity)).toEqual({ kind: 'rate', rate: 1.0002 })
  })

  it('"nudge" keeps the rate when it would barely change', () => {
    expect(decideCorrection('nudge', plain(20, 20, 20), 1.002, 0, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" restarts errors too big to nudge away, respecting the cooldown', () => {
    expect(decideCorrection('nudge', plain(80, 90), 1, 0, Infinity)).toEqual({ kind: 'resync' })
    expect(decideCorrection('nudge', plain(80, 85, 90), 1, 0, RESYNC_COOLDOWN_MS - 1))
      .toEqual({ kind: 'rate', rate: 1.003 })
  })
})

describe('nudgeRate', () => {
  it('is proportional to the error and clamped to ±0.3 %', () => {
    expect(nudgeRate(10)).toBe(1.001)
    expect(nudgeRate(-25)).toBe(0.9975)
    expect(nudgeRate(45)).toBe(1 + NUDGE_MAX_RATE_DEVIATION)
    expect(nudgeRate(-45)).toBe(1 - NUDGE_MAX_RATE_DEVIATION)
  })
})
