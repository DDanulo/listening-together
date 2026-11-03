import { describe, expect, it } from 'vitest'
import { RESYNC_COOLDOWN_MS, RESYNC_THRESHOLD_MS, needsResync } from './drift'

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
