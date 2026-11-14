import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { EventLocation } from '../../common/eventInfo'
import { eventMapCoordinate } from './eventMapCoordinate'

const at = (
  latitude: number | null,
  longitude: number | null
): EventLocation => ({ latitude, longitude, tileUrl: '' })

describe('eventMapCoordinate', () => {
  it('returns a valid point', () => {
    expect(eventMapCoordinate(at(32.73, -117.13))).deep.equals({
      latitude: 32.73,
      longitude: -117.13
    })
  })
  it('accepts the poles and the antimeridian', () => {
    for (const [latitude, longitude] of [
      [90, 180],
      [-90, -180]
    ])
      expect(eventMapCoordinate(at(latitude, longitude))).deep.equals({
        latitude,
        longitude
      })
  })
  it('refuses a missing, non-finite or out-of-range point', () => {
    for (const [latitude, longitude] of [
      [null, 1],
      [1, null],
      [NaN, 1],
      [1, Infinity],
      [91, 1],
      [1, -181]
    ])
      expect(() => eventMapCoordinate(at(latitude, longitude))).throws(
        'The address could not be located.'
      )
  })
})
