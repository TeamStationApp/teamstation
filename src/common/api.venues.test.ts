import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TeamStationClient } from './api'
import type { VenueDetail, VenueSummary } from './venues'

const detail: VenueDetail = {
  id: 'ven/1',
  placeId: 'example-park',
  name: 'Example Park',
  address: '1 Example Way',
  timezone: 'America/New_York',
  sizeSwitchMinutes: 0,
  defaultHours: [],
  defaultBlackouts: [],
  photoUrl: null,
  photoLargeUrl: null,
  owners: [],
  claims: [],
  fields: [],
  rights: {
    canEdit: true,
    claimLeagues: [],
    canClaim: false,
    canRequest: false,
    claimBlocked: null,
    leaveClaimIds: [],
    canRemoveOwners: false,
    decidableClaimIds: []
  },
  map: {
    latitude: 40,
    longitude: -75,
    tileUrl: 'https://tiles.example.test/{z}/{x}/{y}.png',
    googleMapsApiKey: undefined
  }
}
const summary: VenueSummary = {
  id: null,
  placeId: 'harbor-field',
  name: 'Harbor Field',
  address: '1 Demo Way',
  owners: [],
  pendingClaim: false,
  claimed: false,
  group: 'unclaimed',
  distanceKm: null
}

interface Call {
  url: string
  method: string
  body: unknown
}

function client(answer: unknown): { api: TeamStationClient; calls: Call[] } {
  const calls: Call[] = []
  const api = new TeamStationClient({
    baseUrl: '/api/v1',
    fetch: (async (url: unknown, init?: { method?: string; body?: string }) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body == null ? undefined : JSON.parse(init.body)
      })
      return new Response(JSON.stringify(answer), { status: 200 })
    }) as unknown as typeof fetch
  })
  return { api, calls }
}

describe('api client venues', () => {
  it('lists venues by query, distance and leagues on the one collection', async () => {
    const { api, calls } = client({ items: [summary] })
    expect(await api.venues()).deep.equals([summary])
    await api.venues({
      query: ' Harbor ',
      near: { latitude: 40.5, longitude: -75.25 },
      leagueIds: ['lea_a', 'lea_b']
    })
    await api.venues({ query: ' ' })
    expect(calls.map(call => call.url)).deep.equals([
      '/api/v1/venues',
      '/api/v1/venues?query=Harbor&near=40.5%2C-75.25&league=lea_a&league=lea_b',
      '/api/v1/venues'
    ])
  })

  it('reads a place and a venue, and sends claims, decisions, edits and fields', async () => {
    const place = client({ items: [detail] })
    expect((await place.api.venueForPlace('google:example park')).name).equals(
      'Example Park'
    )
    expect(place.calls[0].url).equals(
      '/api/v1/venues?place=google%3Aexample%20park'
    )
    let missing: unknown
    await client({ items: [] })
      .api.venueForPlace('nope-place')
      .catch((error: unknown) => {
        missing = error
      })
    expect(missing).include({ code: 'notFound' })
    const { api, calls } = client(detail)
    await api.venue('ven/1')
    await api.claimPlace('example-park', 'lea_a')
    await api.claimVenue('ven/1', 'lea_b')
    await api.decideVenueClaim('ven/1', 'vcl/1', 'approve')
    await api.endVenueClaim('ven/1', 'vcl/1')
    await api.updateVenue('ven/1', { sizeSwitchMinutes: 30 })
    await api.createField('ven/1', { name: 'Field 1', sizes: ['50/70'] })
    await api.updateField('ven/1', 'fld/1', { hours: null })
    await api.deleteField('ven/1', 'fld/1')
    expect(calls.map(call => [call.method, call.url, call.body])).deep.equals([
      ['GET', '/api/v1/venues/ven%2F1', undefined],
      [
        'POST',
        '/api/v1/venues',
        { placeId: 'example-park', leagueId: 'lea_a' }
      ],
      ['POST', '/api/v1/venues/ven%2F1/claims', { leagueId: 'lea_b' }],
      [
        'POST',
        '/api/v1/venues/ven%2F1/claims/vcl%2F1/decisions',
        { decision: 'approve' }
      ],
      ['DELETE', '/api/v1/venues/ven%2F1/claims/vcl%2F1', undefined],
      ['PUT', '/api/v1/venues/ven%2F1', { sizeSwitchMinutes: 30 }],
      [
        'POST',
        '/api/v1/venues/ven%2F1/fields',
        { name: 'Field 1', sizes: ['50/70'] }
      ],
      ['PUT', '/api/v1/venues/ven%2F1/fields/fld%2F1', { hours: null }],
      ['DELETE', '/api/v1/venues/ven%2F1/fields/fld%2F1', undefined]
    ])
  })
})
