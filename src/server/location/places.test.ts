import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asLocality, localityLabel } from '../../common/locality'
import { findPlaces, nearestPlace, type Place } from './places'

const sample: Place[] = [
  ['1', 'Demo City', 'Demo Region', 'US', 20, 30, 'UTC', 1000],
  ['2', 'Demo City', 'Other Region', 'CA', 25, 35, 'UTC', 500],
  ['3', 'Cité', 'Demo Region', 'US', 20, 30, 'UTC', 200]
]
describe('public locality lookup', () => {
  it('disambiguates regions, searches accents and preserves population/id order', () => {
    expect(
      findPlaces('Demo City', sample).map(place => place.placeId)
    ).deep.equals(['1', '2'])
    expect(
      findPlaces('Demo City CA', sample).map(place => place.region)
    ).deep.equals(['Other Region'])
    expect(findPlaces('cite', sample)).length(1)
    expect(findPlaces('', sample)).length(0)
    expect(findPlaces('missing', sample)).length(0)
    expect(findPlaces('York')).not.length(0)
    expect(
      findPlaces('Demo', [
        sample[0],
        ['0', 'Demo City', 'Demo Region', 'US', 20, 30, 'UTC', 1000]
      ])[0].placeId
    ).equals('0')
  })
  it('suggests a locality without returning the transient coordinates', () => {
    const place = nearestPlace(20.1, 30.1, sample)
    expect(place?.placeId).equals('1')
    expect(place).not.property('latitude')
    expect(nearestPlace(0, 0, [])).equals(null)
    for (const [lat, lon] of [
      [NaN, 0],
      [91, 0],
      [0, 181]
    ])
      expect(() => nearestPlace(lat, lon, sample)).throws('invalid')
  })
  it('requires manual locality and a real timezone, retaining only allowed fields', () => {
    const city = asLocality({
      city: ' Demo ',
      region: 'Region',
      country: 'US',
      timezone: 'UTC',
      latitude: 20
    })
    expect(city).deep.equals({
      city: 'Demo',
      region: 'Region',
      country: 'US',
      timezone: 'UTC',
      placeId: null
    })
    expect(localityLabel(city)).equals('Demo, Region, US')
    expect(localityLabel(null)).equals('Location not set')
    expect(asLocality({ ...city, placeId: '1' }).placeId).equals('1')
    for (const raw of [
      null,
      [],
      {},
      { ...city, timezone: 'Not/A_Timezone' },
      { ...city, city: '' },
      { ...city, region: 'a'.repeat(121) }
    ])
      expect(() => asLocality(raw)).throws(TypeError)
  })
})
