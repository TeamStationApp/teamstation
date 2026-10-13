import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { googlePlacesStub } from '../../test/googlePlacesStub'
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
})
