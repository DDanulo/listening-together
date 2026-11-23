import { describe, expect, it } from 'vitest'
import { experimentOptions } from './experiment'

describe('experimentOptions', () => {
  it('reads the drift strategy and the naive baseline', () => {
    expect(experimentOptions('?drift=resync&naive=1')).toEqual({ naive: true, drift: 'resync' })
  })

  it('falls back to the defaults for missing or unknown values', () => {
    expect(experimentOptions('')).toEqual({ naive: false, drift: undefined })
    expect(experimentOptions('?drift=fast')).toEqual({ naive: false, drift: undefined })
  })
})
