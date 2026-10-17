import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { googlePlacesStub } from '../../test/googlePlacesStub'
import { eventGeocoder } from '../location/eventGeocoder'
import { googlePlaces } from '../location/googlePlaces'
import { eventInfoRoutes } from './eventInfo'
import { locationRoutes } from './location'

describe('Google primary event location HTTP contract', function () {
  this.timeout(60000)
  let h: AccountHarness
  let stub: Awaited<ReturnType<typeof googlePlacesStub>>
  let fallbackCalls = 0
  let eventId: string
  before(async () => {
    stub = await googlePlacesStub()
    const google = googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: stub.baseUrl
    })
    h = await accountHarness(undefined, (app, { db, media }) => {
      app.use(
        '/api/v1',
        locationRoutes(
          {
            search: async () => {
              fallbackCalls++
              return [
                {
                  id: 'fallback-field',
                  name: 'Harbor Field',
                  address: '1 Demo Way, Demo City'
                }
              ]
            }
          },
          { db, googlePlaces: google }
        )
      )
      app.use(
        '/api/v1',
        eventInfoRoutes(db, media, {
          googleMapsApiKey: '',
          geocoder: eventGeocoder(db, { googlePlaces: google })
        })
      )
    })
    await h.db
      .updateTable('memberships')
      .set({ role: 'manager' })
      .where('user_id', '=', 101)
      .execute()
    const created = await h.request('POST', '/events', {
      teamId: 'tem_account',
      eventType: 'other',
      title: 'Team dinner',
      startAt: '2027-04-10T18:00:00.000Z',
      timezone: 'UTC',
      address: '1 Demo Way, Demo City',
      idempotencyKey: 'google-location-event'
    })
    expect(created.status).equals(201)
    eventId = (await created.json()).id
  })
  beforeEach(async () => {
    stub.controls.fail = false
    stub.controls.empty = false
    stub.controls.malformed = false
    stub.controls.delay = 0
    fallbackCalls = 0
    await h.resetLimits()
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
        join(artifacts, 'google-provider-api.log'),
        `$ HTTP GET ${path} actor=${user ?? 'anonymous'}\n${response.status} ${await response.clone().text()}\n`
      )
    }
    return response
  }
  it('uses Google and its attribution while keeping the old array client compatible', async () => {
    const client = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(101)
    })
    const result = await client.eventPlaceSuggestions('Harbor', 'venue')
    expect(result.provider).equals('google')
    expect(result.attribution).equals('Powered by Google')
    expect(await client.eventPlaces('Harbor', 'venue')).deep.equals(
      result.places
    )
    expect(
      (await (await get('/locations?kind=address&query=Demo')).json()).places
    ).length(5)
    expect(
      (await (await get('/locations?kind=venue&query=x')).json()).provider
    ).equals('google')
    expect(fallbackCalls).equals(0)
    expect(
      (await get('/locations?kind=venue&query=Harbor', null)).status
    ).equals(401)
    const calls = stub.calls.length
    expect(
      (await get('/locations?kind=venue&query=' + 'x'.repeat(121))).status
    ).equals(400)
    expect(stub.calls).length(calls)
  })
  it('keeps valid empty results and uses Photon only for unavailable Google', async () => {
    stub.controls.empty = true
    const empty = await (await get('/locations?kind=venue&query=Harbor')).json()
    expect(empty).include({
      provider: 'google',
      attribution: 'Powered by Google'
    })
    expect(empty.places).deep.equals([])
    expect(fallbackCalls).equals(0)
    stub.controls.empty = false
    stub.controls.fail = true
    const fallback = await (
      await get('/locations?kind=venue&query=Harbor')
    ).json()
    expect(fallback).include({
      provider: 'openstreetmap',
      attribution: '© OpenStreetMap contributors'
    })
    expect(fallbackCalls).equals(1)
  })
  it('shares the search budget and refuses paid work after its limit', async () => {
    for (let i = 0; i < 120; i++)
      expect((await get('/locations?kind=venue&query=Harbor')).status).equals(
        200
      )
    const calls = stub.calls.length
    expect((await get('/locations?kind=address&query=Demo')).status).equals(429)
    expect(stub.calls).length(calls)
    expect(fallbackCalls).equals(0)
  })
  it('limits authorized Google event geocoding and never persists its coordinates', async () => {
    for (let i = 0; i < 30; i++) {
      const result = await get(`/events/${eventId}/location`)
      expect(result.status).equals(200)
      expect(await result.json()).include({ latitude: 34, longitude: 12 })
    }
    expect((await get(`/events/${eventId}/location`)).status).equals(429)
    expect(
      await h.db.selectFrom('event_geocodes').selectAll().execute()
    ).deep.equals([])
  })
})
