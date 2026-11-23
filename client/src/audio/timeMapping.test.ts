import { describe, expect, it } from 'vitest'
import {
  MAX_TIMESTAMP_AGE_MS, audioToClientTime, catchUpStart, clientToAudioTime, isFresh, positionAtAudioTime, positionErrorMs,
  serverToClientTime,
} from './timeMapping'

describe('time mapping', () => {
  it('converts server time → client time → AudioContext seconds', () => {
    // server clock is 1500 ms ahead; audio clock read 12.5 s when performance.now() was 40 000 ms
    const clientTime = serverToClientTime(43_000, 1_500)
    const audioTime = clientToAudioTime(clientTime, { contextTime: 12.5, performanceTime: 40_000 })

    expect(clientTime).toBe(41_500)
    expect(audioTime).toBeCloseTo(14.0) // 12.5 s + 1500 ms
  })

  it('maps times before the reference pair into the past', () => {
    expect(clientToAudioTime(39_750, { contextTime: 12.5, performanceTime: 40_000 })).toBeCloseTo(12.25)
  })
})

describe('audioToClientTime', () => {
  it('is the inverse of clientToAudioTime', () => {
    const pair = { contextTime: 12.5, performanceTime: 40_000 }
    expect(audioToClientTime(clientToAudioTime(41_234.5, pair), pair)).toBeCloseTo(41_234.5)
  })
})

describe('isFresh', () => {
  it('accepts a reading within the allowed age and rejects old ones', () => {
    const pair = { contextTime: 12.5, performanceTime: 40_000 }
    expect(isFresh(pair, 40_000 + MAX_TIMESTAMP_AGE_MS)).toBe(true)
    expect(isFresh(pair, 40_000 + MAX_TIMESTAMP_AGE_MS + 1)).toBe(false)
    expect(isFresh({ contextTime: 0, performanceTime: 0 }, 10)).toBe(false)
  })
})

describe('positionAtAudioTime', () => {
  const anchors = [
    { audioTime: 10, position: 30_000, rate: 1 },
    { audioTime: 20, position: 40_000, rate: 1.002 },
    { audioTime: 30, position: 50_020, rate: 1 },
  ]

  it('advances in real time at rate 1', () => {
    expect(positionAtAudioTime(anchors, 15)).toBeCloseTo(35_000)
  })

  it('advances faster after a rate change', () => {
    // 10 s at 1.002 → 10 020 ms of track
    expect(positionAtAudioTime(anchors, 25)).toBeCloseTo(45_010)
  })

  it('uses the latest anchor that has started', () => {
    expect(positionAtAudioTime(anchors, 31)).toBeCloseTo(51_020)
  })
})

describe('positionErrorMs', () => {
  // The track should be at 30 000 ms at server time 100 000; offset +60 000 → client time 40 000.
  const segment = { startAt: 100_000, position: 30_000 }

  it('is zero when the source plays exactly what the server timeline says', () => {
    // Audio clock 12.0 s ↔ client 40 000 ms; the source started at 12.0 s from 30 000 ms. 2 s later:
    const anchors = [{ audioTime: 12, position: 30_000, rate: 1 }]
    expect(positionErrorMs(segment, anchors, { contextTime: 14, performanceTime: 42_000 }, 60_000)).toBeCloseTo(0)
  })

  it('is positive when the source started late (behind)', () => {
    const anchors = [{ audioTime: 12.015, position: 30_000, rate: 1 }]
    expect(positionErrorMs(segment, anchors, { contextTime: 14, performanceTime: 42_000 }, 60_000)).toBeCloseTo(15)
  })

  it('shrinks while a faster rate catches up', () => {
    // 15 ms late, then 1.003 from 13 s: after 5 s at 1.003 it has caught up 15 ms
    const anchors = [
      { audioTime: 12.015, position: 30_000, rate: 1 },
      { audioTime: 13, position: 30_985, rate: 1.003 },
    ]
    expect(positionErrorMs(segment, anchors, { contextTime: 18, performanceTime: 46_000 }, 60_000)).toBeCloseTo(0)
  })
})

describe('catchUpStart', () => {
  it('keeps a start that is far enough ahead', () => {
    expect(catchUpStart(10.5, 30_000, 10.02)).toEqual({ when: 10.5, position: 30_000 })
  })

  it('moves a start in the past to the earliest time and skips ahead by the same amount', () => {
    // planned 18 ms before the earliest possible start → start there, 18 ms further into the track
    const start = catchUpStart(10.002, 30_000, 10.02)
    expect(start.when).toBe(10.02)
    expect(start.position).toBeCloseTo(30_018)
  })
})
