import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { EXAMPLE_PARK, googlePlacesStub } from '../../test/googlePlacesStub'
import { googlePlaces } from './googlePlaces'

describe('Google city lookup', () => {
  let stub: Awaited<ReturnType<typeof googlePlacesStub>>
  beforeEach(async () => {
    stub = await googlePlacesStub()
  })
  afterEach(async () => {
    await stub.close()
  })
  it('limits autocomplete to cities and carries a session and field mask', async () => {
    const client = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl
    })
    const rows = await client.autocomplete('au', 'city-session')
    expect(rows).length(8)
    expect(rows[0]).deep.equals({
      id: 'google:austin',
      primary: 'Austin',
      secondary: 'Texas, United States'
    })
    expect(stub.calls[0]).include({
      key: 'placeholder-key',
      mask: 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat'
    })
    expect(stub.calls[0].body).deep.equals({
      input: 'au',
      sessionToken: 'city-session',
      includedPrimaryTypes: ['(cities)'],
      languageCode: 'en'
    })
  })
  for (const id of ['austin', 'postal', 'township'])
    it(`resolves ${id} to a locality without coordinates or caching`, async () => {
      const client = googlePlaces({
        apiKey: 'placeholder-key',
        baseUrl: stub.baseUrl
      })
      const location = await client.locality(id, 'city-session')
      expect(location).deep.equals({
        city: 'Austin',
        region: 'Texas',
        country: 'United States',
        placeId: `google:${id}`,
        timezone: 'America/Chicago'
      })
      await client.locality(id)
      expect(
        stub.calls.filter(call => call.path.startsWith('/v1/places/'))
      ).length(2)
      expect(
        stub.calls.filter(call =>
          call.path.startsWith('/maps/api/timezone/json')
        )
      ).length(2)
      expect(stub.calls[0].mask).equals('addressComponents,location')
      expect(stub.calls[0].path).includes('sessionToken=city-session')
    })
  it('uses the country as the region for a city-state', async () => {
    const client = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl
    })
    expect(await client.locality('singapore')).include({
      region: 'Singapore',
      country: 'Singapore',
      timezone: 'Asia/Singapore'
    })
  })
  it('keeps a selected Portuguese border town in its own time zone without retaining coordinates', async () => {
    const client = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl
    })
    for (const fallback of [false, true]) {
      stub.controls.timeZoneFail = fallback
      expect(await client.locality('bemposta')).deep.equals({
        city: 'Bemposta',
        region: 'Bragança',
        country: 'Portugal',
        placeId: 'google:bemposta',
        timezone: 'Europe/Lisbon'
      })
    }
  })
  it('falls back to the selected coordinates when the Google time-zone request times out', async () => {
    const client = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl,
      timeoutMs: 25
    })
    stub.controls.timeZoneDelay = 100
    expect(await client.locality('bemposta')).property(
      'timezone',
      'Europe/Lisbon'
    )
  })
  it('refuses non-city data and missing IDs', async () => {
    const client = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl
    })
    for (const [id, code] of [
      ['no-city', 'invalidLocation'],
      ['missing', 'notFound']
    ]) {
      try {
        await client.locality(id)
        expect.fail('must reject')
      } catch (error) {
        expect(error).property('code', code)
      }
    }
  })
  it('reports failed and timed-out lookups without provider or key details', async () => {
    const client = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl,
      timeoutMs: 25
    })
    for (const delayed of [false, true]) {
      stub.controls.fail = !delayed
      stub.controls.delay = delayed ? 100 : 0
      try {
        await client.autocomplete('austin', 'city-session')
        expect.fail('must reject')
      } catch (error) {
        expect(error).property('code', 'unavailable')
        expect(String(error)).not.includes('placeholder-key')
      }
    }
  })
  it('searches named venues and addresses with bounded results and no caching', async () => {
    const client = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl
    })
    expect(await client.eventPlaces('x', 'venue')).deep.equals([])
    expect(stub.calls).length(0)
    expect(await client.eventPlaces('Harbor', 'venue')).deep.equals([
      {
        id: 'google:harbor-field',
        name: 'Harbor Field',
        address: '1 Demo Way, Demo City'
      }
    ])
    const addresses = await client.eventPlaces('Demo Way', 'address')
    expect(addresses).length(5)
    expect(addresses[1].name).equals(null)
    await client.eventPlaces('Harbor', 'venue')
    expect(stub.calls).length(3)
    expect(stub.calls[0]).include({
      key: 'placeholder-key',
      mask: 'places.id,places.displayName,places.formattedAddress,places.primaryType'
    })
    expect(stub.calls[0].body).deep.equals({
      textQuery: 'Harbor',
      languageCode: 'en',
      pageSize: 5
    })
  })
  it('looks up coordinates without persisting them and distinguishes no match from outage', async () => {
    const client = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl,
      timeoutMs: 25
    })
    expect(await client.coordinates('1 Demo Way')).deep.equals({
      latitude: 34,
      longitude: 12
    })
    await client.coordinates('1 Demo Way')
    expect(stub.calls).length(2)
    expect(stub.calls[0].mask).equals('places.location')
    expect(stub.calls[0].body).deep.equals({
      textQuery: '1 Demo Way',
      languageCode: 'en',
      pageSize: 1
    })
    stub.controls.empty = true
    expect(await client.eventPlaces('No match', 'venue')).deep.equals([])
    try {
      await client.coordinates('No match')
      expect.fail('must reject')
    } catch (error) {
      expect(error).property('code', 'notFound')
    }
    stub.controls.empty = false
    stub.controls.invalidCoordinates = true
    try {
      await client.coordinates('Invalid point')
      expect.fail('must reject')
    } catch (error) {
      expect(error).property('code', 'unavailable')
    }
    stub.controls.invalidCoordinates = false
    for (const mode of ['malformed', 'fail', 'delay'] as const) {
      stub.controls.malformed = mode === 'malformed'
      stub.controls.fail = mode === 'fail'
      stub.controls.delay = mode === 'delay' ? 100 : 0
      for (const lookup of [
        async () => await client.eventPlaces('Harbor', 'venue'),
        async () => await client.coordinates('1 Demo Way')
      ]) {
        try {
          await lookup()
          expect.fail('must reject')
        } catch (error) {
          expect(error).property('code', 'unavailable')
          expect(String(error)).not.includes('placeholder-key')
        }
      }
    }
  })

  it('reads a venue place with its time zone, and refuses a broken answer', async () => {
    const client = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl
    })
    expect(await client.venueDetails(EXAMPLE_PARK.id)).deep.equals({
      placeId: EXAMPLE_PARK.id,
      name: EXAMPLE_PARK.name,
      address: EXAMPLE_PARK.address,
      latitude: EXAMPLE_PARK.location.latitude,
      longitude: EXAMPLE_PARK.location.longitude,
      timezone: 'America/New_York'
    })
    expect(stub.calls[0]).include({
      path: `/v1/places/${EXAMPLE_PARK.id}?languageCode=en`,
      mask: 'id,displayName,formattedAddress,location'
    })
    // Without its Google time zone, boundary data still names the zone.
    stub.controls.timeZoneFail = true
    expect((await client.venueDetails(EXAMPLE_PARK.id)).timezone).equals(
      'America/New_York'
    )
    stub.controls.timeZoneFail = false
    let missing: unknown
    await client.venueDetails('no-such-place').catch((error: unknown) => {
      missing = error
    })
    expect(String(missing)).includes('Not found')
    for (const control of ['malformed', 'invalidCoordinates'] as const) {
      stub.controls[control] = true
      let broken: unknown
      await client.venueDetails(EXAMPLE_PARK.id).catch((error: unknown) => {
        broken = error
      })
      expect((broken as { code?: string }).code, control).equals('unavailable')
      stub.controls[control] = false
    }
    stub.controls.fail = true
    let down: unknown
    await client.venueDetails(EXAMPLE_PARK.id).catch((error: unknown) => {
      down = error
    })
    expect(String(down)).includes('unavailable')
  })
})
