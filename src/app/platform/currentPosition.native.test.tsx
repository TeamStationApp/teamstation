import { expect } from 'chai'
import { describe, it } from 'mocha'

import { geolocationControls } from '../../test/geolocationStub'
import { currentPosition } from './currentPosition.native'

describe('the current position on a phone', () => {
  it('answers the phone’s position, or null when it is refused', async () => {
    geolocationControls.answer = { latitude: 40.02, longitude: -75.22 }
    expect(await currentPosition()).deep.equals({
      latitude: 40.02,
      longitude: -75.22
    })
    geolocationControls.answer = null
    expect(await currentPosition()).equals(null)
  })
})
