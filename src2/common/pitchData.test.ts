import { expect } from 'chai'
import { describe, it } from 'mocha'

import { isPitchSpeed, isPitchZone } from './pitchData'

describe('pitch speeds', function () {
  it('are finite miles an hour from 20 to 110', function () {
    for (const mph of [20, 45.5, 88, 110])
      expect(isPitchSpeed(mph), String(mph)).equals(true)
    for (const value of [19.9, 110.1, 0, -60, Number.NaN, Infinity, '88', null])
      expect(isPitchSpeed(value), String(value)).equals(false)
  })
})

describe('pitch zones', function () {
  it('are 1 to 9 and 11 to 14, whole', function () {
    for (const zone of [1, 5, 9, 11, 14])
      expect(isPitchZone(zone), String(zone)).equals(true)
    for (const value of [0, 10, 15, 2.5, -1, Number.NaN, '5', null])
      expect(isPitchZone(value), String(value)).equals(false)
  })
})
