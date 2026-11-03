import { describe, expect, it } from 'vitest'
import type { PlaybackState } from '../protocol/types'
import { SCHEDULE_MARGIN_MS, audiblePosition, expectedPosition, planTransition, type Segment } from './playback'

const playing = (rev: number, position: number, effectiveAt: number, trackId = 't_a'): PlaybackState => ({
  rev, status: 'playing', trackId, position, effectiveAt,
})
const paused = (rev: number, position: number, effectiveAt: number): PlaybackState => ({
  rev, status: 'paused', trackId: 't_a', position, effectiveAt,
})
const segment = (rev: number, startAt: number, position = 0, stopAt: number | null = null): Segment => ({
  rev, trackId: 't_a', startAt, position, stopAt,
})

describe('expectedPosition', () => {
  it('advances with time while playing, also before effectiveAt', () => {
    const state = playing(1, 30_000, 100_000)
    expect(expectedPosition(state, 105_000)).toBe(35_000)
    expect(expectedPosition(state, 99_000)).toBe(29_000)
  })

  it('is constant while paused', () => {
    expect(expectedPosition(paused(1, 31_000, 931_000), 999_999)).toBe(31_000)
  })
})

describe('planTransition', () => {
  it('schedules a future state exactly at effectiveAt', () => {
    const plan = planTransition([], playing(1, 0, 10_000), 9_000, 200_000)

    expect(plan.start).toEqual({ rev: 1, trackId: 't_a', startAt: 10_000, position: 0 })
  })

  it('starts a late state now, at the position it has reached', () => {
    // effectiveAt passed 4 s ago (late join): start after the margin, 4 s + margin into the track
    const plan = planTransition([], playing(1, 30_000, 10_000), 14_000, 200_000)

    expect(plan.start).toEqual({
      rev: 1,
      trackId: 't_a',
      startAt: 14_000 + SCHEDULE_MARGIN_MS,
      position: 34_000 + SCHEDULE_MARGIN_MS,
    })
  })

  it('treats effectiveAt closer than the margin as late', () => {
    const plan = planTransition([], playing(1, 0, 10_010), 10_000, 200_000)

    expect(plan.start?.startAt).toBe(10_000 + SCHEDULE_MARGIN_MS)
    expect(plan.start?.position).toBe(SCHEDULE_MARGIN_MS - 10)
  })

  it('stops playing audio exactly at effectiveAt on pause, and starts nothing', () => {
    const current = segment(1, 0)
    const plan = planTransition([current], paused(2, 31_000, 31_000), 30_000, 200_000)

    expect(plan.stop).toEqual([{ segment: current, at: 31_000 }])
    expect(plan.cancel).toEqual([])
    expect(plan.start).toBeNull()
  })

  it('cancels audio that would only start at or after the change', () => {
    const pending = segment(1, 12_000)
    const plan = planTransition([pending], paused(2, 0, 12_000), 11_500, 200_000)

    expect(plan.cancel).toEqual([pending])
    expect(plan.stop).toEqual([])
  })

  it('keeps an earlier scheduled stop (pause pending, then play)', () => {
    // pause takes effect at 31 s; play arrives and takes effect at 46 s
    const stoppingAt31 = segment(1, 0, 0, 31_000)
    const plan = planTransition([stoppingAt31], playing(3, 31_000, 46_000), 45_000, 200_000)

    expect(plan.stop).toEqual([])
    expect(plan.cancel).toEqual([])
    expect(plan.start).toEqual({ rev: 3, trackId: 't_a', startAt: 46_000, position: 31_000 })
  })

  it('swaps segments at effectiveAt on seek', () => {
    const current = segment(1, 0)
    const plan = planTransition([current], playing(2, 95_000, 50_000), 49_000, 200_000)

    expect(plan.stop).toEqual([{ segment: current, at: 50_000 }])
    expect(plan.start).toEqual({ rev: 2, trackId: 't_a', startAt: 50_000, position: 95_000 })
  })

  it('does not start a second segment for the same state', () => {
    const plan = planTransition([segment(2, 50_000, 95_000)], playing(2, 95_000, 50_000), 49_000, 200_000)

    expect(plan.start).toBeNull()
  })

  it('does not start when the track would already be over', () => {
    const plan = planTransition([], playing(1, 0, 0), 300_000, 200_000)

    expect(plan.start).toBeNull()
  })
})

describe('audiblePosition', () => {
  it('follows the segment playing now', () => {
    const segments = [segment(1, 0, 0, 31_000), segment(2, 46_000, 31_000)]

    expect(audiblePosition(segments, 10_000)).toBe(10_000)
    expect(audiblePosition(segments, 40_000)).toBeNull()
    expect(audiblePosition(segments, 50_000)).toBe(35_000)
  })
})
