import { describe, expect, it } from 'vitest'
import { experimentOptions } from './experiment'

describe('experimentOptions', () => {
  it('reads every evaluation switch', () => {
    expect(experimentOptions('?drift=resync&naive=1&clock=single&evalChannel=2')).toEqual({
      naive: true, drift: 'resync', clock: 'single', evalChannel: '2',
    })
  })

  it('falls back to the defaults for missing or unknown values', () => {
    const defaults = { naive: false, drift: undefined, clock: undefined, evalChannel: undefined }
    expect(experimentOptions('')).toEqual(defaults)
    expect(experimentOptions('?drift=fast&clock=atomic&evalChannel=7')).toEqual(defaults)
  })
})
