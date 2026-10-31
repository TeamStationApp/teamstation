import { expect } from 'chai'
import { describe, it } from 'mocha'

import { tvLocation } from './tvLocation'

describe('TV approximate location', () => {
  it('uses a bounded optional local lookup with an honest unavailable fallback', async () => {
    expect(await tvLocation(null)).equals(null)
    expect(await tvLocation('192.0.2.1')).equals(null)
    expect(await tvLocation('192.0.2.1', async () => ' Example City ')).equals(
      'Example City'
    )
    expect(await tvLocation('192.0.2.1', async () => '')).equals(null)
    expect(await tvLocation('192.0.2.1', async () => null)).equals(null)
    expect(
      await tvLocation('192.0.2.1', async () => {
        throw new Error('unavailable')
      })
    ).equals(null)
    expect(
      await tvLocation('192.0.2.1', async () => await new Promise(() => {}), 1)
    ).equals(null)
  })
})
