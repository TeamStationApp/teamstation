import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { googlePlacesStub } from '../../test/googlePlacesStub'
import { googlePlaces } from '../location/googlePlaces'
import { locationRoutes } from './location'

describe('city suggestions and details HTTP contract', function () {
  this.timeout(60000)
  let h: AccountHarness
  let stub: Awaited<ReturnType<typeof googlePlacesStub>>
  before(async () => {
    stub = await googlePlacesStub()
    h = await accountHarness(undefined, (app, { db }) => {
      app.use(
        '/api/v1',
        locationRoutes(undefined, {
          db,
          googlePlaces: googlePlaces({
            apiKey: 'placeholder-key',
            baseUrl: stub.baseUrl
          })
        })
      )
    })
  })
  after(async () => {
    await h?.close()
    await stub?.close()
  })
  async function get(
    path: string,
    user: number | null = 101
  ): Promise<Response> {
    const response = await h.request('GET', path, undefined, user)
    const artifacts = process.env.TS_SETTINGS_ARTIFACTS
    if (artifacts != null) {
      await mkdir(artifacts, { recursive: true })
      await appendFile(
        join(artifacts, 'locations-api.log'),
        `$ HTTP GET ${path} actor=${user ?? 'anonymous'}\n${response.status} ${await response.clone().text()}\n`
      )
    }
    return response
  }
  it('keeps legacy catalogue responses and uses Google only for a signed-in search session', async () => {
    const legacy = (await (await get('/locations?query=austin')).json()) as {
      places: unknown[]
      provider: string
    }
    expect(legacy.provider).equals('geonames')
    const signed = (await (
      await get('/locations?query=austin&session=city-session')
    ).json()) as {
      places: unknown[]
      provider: string
      suggestions: Array<{ id: string }>
    }
    expect(signed.places).deep.equals(legacy.places)
    expect(signed.provider).equals('google')
    expect(signed.suggestions[0].id).equals('google:austin')
    const anonymous = (await (
      await get('/locations?query=austin&session=city-session', null)
    ).json()) as { provider: string }
    expect(anonymous.provider).equals('geonames')
  })
  it('resolves both provider IDs, refuses unknown IDs and protects paid details', async () => {
    const signed = await get('/locations/google:austin?session=city-session')
    expect(signed.status).equals(200)
    expect(
      ((await signed.json()) as { place: { timezone: string } }).place.timezone
    ).equals('America/Chicago')
    expect((await get('/locations/google:austin', null)).status).equals(401)
    const lookup = (await (
      await get('/locations?query=austin', null)
    ).json()) as { suggestions: Array<{ id: string }> }
    expect(
      (await get(`/locations/${lookup.suggestions[0].id}`, null)).status
    ).equals(200)
    expect((await get('/locations/geonames:missing')).status).equals(404)
    expect((await get('/locations/unknown:missing')).status).equals(404)
    expect((await get('/locations/google:no-city')).status).equals(422)
    expect((await get('/locations?query=austin&session=')).status).equals(400)
  })
  it('limits autocomplete and detail requests independently per account', async () => {
    await h.resetLimits()
    for (let index = 0; index < 120; index++)
      expect(
        (await get('/locations?query=austin&session=city-session')).status
      ).equals(200)
    expect(
      (await get('/locations?query=austin&session=city-session')).status
    ).equals(429)
    expect(
      (await get('/locations?query=austin&session=city-session', 102)).status
    ).equals(200)
    for (let index = 0; index < 30; index++)
      expect(
        (await get('/locations/google:austin?session=city-session')).status
      ).equals(200)
    expect(
      (await get('/locations/google:austin?session=city-session')).status
    ).equals(429)
  })
})
