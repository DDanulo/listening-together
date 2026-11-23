import { describe, expect, it } from 'vitest'
import {
  NUDGE_MAX_RATE_DEVIATION, RESYNC_COOLDOWN_MS, RESYNC_THRESHOLD_MS, decideCorrection, needsResync, nudgeRate,
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

describe('decideCorrection', () => {
  it('never corrects with the "off" strategy', () => {
    expect(decideCorrection('off', [500, 500, 500], 1, Infinity)).toEqual({ kind: 'none' })
  })

  it('"resync" restarts on two confirming readings over 20 ms and ignores smaller errors', () => {
    expect(decideCorrection('resync', [25, 30], 1, Infinity)).toEqual({ kind: 'resync' })
    expect(decideCorrection('resync', [15, 18, 19], 1, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" leaves errors under 5 ms alone', () => {
    expect(decideCorrection('nudge', [4, -3, 4.5], 1, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" speeds up a device that is behind and slows down one that is ahead', () => {
    // median of the last 5 readings = 20 ms → 20 / 10 000 = +0.2 %
    expect(decideCorrection('nudge', [40, 18, 20, 22, 19, 25], 1, Infinity)).toEqual({ kind: 'rate', rate: 1.002 })
    expect(decideCorrection('nudge', [-10, -10, -10], 1, Infinity)).toEqual({ kind: 'rate', rate: 0.999 })
  })

  it('"nudge" ignores outlier readings', () => {
    expect(decideCorrection('nudge', [1, 2, 30], 1, Infinity)).toEqual({ kind: 'none' })
    // the noise pattern seen on Chrome/Linux: steps between −1 and −6 ms
    expect(decideCorrection('nudge', [-1.2, -3.2, -5.9, -6.3, -1.1], 1, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" needs two readings before acting', () => {
    expect(decideCorrection('nudge', [20], 1, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" keeps nudging down to 2 ms (hysteresis), then returns to normal speed', () => {
    expect(decideCorrection('nudge', [4, 4, 4], 1.002, Infinity)).toEqual({ kind: 'rate', rate: 1.0004 })
    expect(decideCorrection('nudge', [1.5, 1, 1.8], 1.0004, Infinity)).toEqual({ kind: 'rate', rate: 1 })
  })

  it('"nudge" keeps the rate when it would barely change', () => {
    expect(decideCorrection('nudge', [20, 20, 20], 1.002, Infinity)).toEqual({ kind: 'none' })
  })

  it('"nudge" restarts errors too big to nudge away, respecting the cooldown', () => {
    expect(decideCorrection('nudge', [80, 90], 1, Infinity)).toEqual({ kind: 'resync' })
    expect(decideCorrection('nudge', [80, 90], 1, RESYNC_COOLDOWN_MS - 1)).toEqual({ kind: 'rate', rate: 1.003 })
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
