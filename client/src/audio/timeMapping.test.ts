import { describe, expect, it } from 'vitest'
import { MAX_TIMESTAMP_AGE_MS, audioToClientTime, clientToAudioTime, isFresh, serverToClientTime } from './timeMapping'

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
