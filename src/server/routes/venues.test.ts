import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { VenueDetail, VenueSummary } from '../../common/venues'
import { accountTestPicture } from '../../test/accountHarness'
import {
  EXAMPLE_PARK,
  googlePlacesStub,
  MORE_PARKS
} from '../../test/googlePlacesStub'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { googlePlaces } from '../location/googlePlaces'
import { CLAIM_WAIT_MS } from '../venues/ownership'
import { distanceKm } from '../venues/venues'

const WEEK = CLAIM_WAIT_MS

describe('venue routes', function () {
  this.timeout(120000)
  let stub: Awaited<ReturnType<typeof googlePlacesStub>>
  let f: GroupFixture
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text()
    expect(response.status, text).equals(status)
    return JSON.parse(text) as T
  }
  const claim = async (
    user = 101,
    leagueId = f.leagueA
  ): Promise<VenueDetail> =>
    await json<VenueDetail>(
      await f.h.request(
        'POST',
        '/venues',
        { placeId: `google:${EXAMPLE_PARK.id}`, leagueId },
        user
      ),
      201
    )
  const list = async (search: string, user = 101): Promise<VenueSummary[]> =>
    (
      await json<{ items: VenueSummary[] }>(
        await f.h.request('GET', `/venues${search}`, undefined, user)
      )
    ).items
  beforeEach(async () => {
    stub = await googlePlacesStub()
    f = await groupFixture(
      undefined,
      undefined,
      undefined,
      googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl }),
      {},
      { googleMapsApiKey: 'placeholder-browser-key' }
    )
  })
  afterEach(async () => {
    await f?.h.close()
    await stub?.close()
  })

  it('reads a Google place, claims it into the registry, and then reads the registry’s', async () => {
    const place = (
      await json<{ items: VenueDetail[] }>(
        await f.h.request('GET', `/venues?place=${EXAMPLE_PARK.id}`)
      )
    ).items[0]
    expect(place).include({
      id: null,
      placeId: EXAMPLE_PARK.id,
      name: EXAMPLE_PARK.name,
      timezone: 'America/New_York'
    })
    expect(place.rights.canClaim).equals(true)
    expect(place.rights.claimLeagues).deep.equals([
      { id: f.leagueA, name: 'Demo League A' }
    ])
    // The map is the point and Google's browser key, plus the tile address
    // that installed builds from before Google's maps still require.
    expect(place.map).deep.equals({
      latitude: EXAMPLE_PARK.location.latitude,
      longitude: EXAMPLE_PARK.location.longitude,
      tileUrl:
        process.env.TS_EVENT_MAP_TILES ??
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      googleMapsApiKey: 'placeholder-browser-key'
    })
    // A place Google doesn't know is no item.
    expect(
      (
        await json<{ items: VenueDetail[] }>(
          await f.h.request('GET', '/venues?place=nope-place', undefined, 101)
        )
      ).items
    ).deep.equals([])
    const venue = await claim()
    expect(venue.id).matches(/^ven_/)
    // A registry venue's map carries the tile address as well.
    expect((venue.map as { tileUrl?: unknown }).tileUrl).a('string')
    expect(venue).include({
      name: EXAMPLE_PARK.name,
      address: EXAMPLE_PARK.address,
      timezone: 'America/New_York',
      sizeSwitchMinutes: 0
    })
    expect(venue.owners).deep.equals([])
    expect(venue.claims.map(c => [c.kind, c.status, c.leagueName])).deep.equals(
      [['claim', 'pending', 'Demo League A']]
    )
    expect(venue.rights.canEdit).equals(true)
    const again = (
      await json<{ items: VenueDetail[] }>(
        await f.h.request('GET', `/venues?place=google:${EXAMPLE_PARK.id}`)
      )
    ).items[0]
    expect(again.id).equals(venue.id)
    // A second league is turned away while the first claim waits.
    const blocked = await f.h.request(
      'POST',
      '/venues',
      { placeId: EXAMPLE_PARK.id, leagueId: f.leagueB },
      102
    )
    expect(blocked.status).equals(409)
    expect(
      (
        await json<VenueDetail>(
          await f.h.request('GET', `/venues/${venue.id!}`, undefined, 102)
        )
      ).rights.claimBlocked
    ).includes('ask to co-own')
  })

  it('refuses a claim for a league the person does not run, and bad bodies', async () => {
    expect(
      (
        await f.h.request(
          'POST',
          '/venues',
          { placeId: EXAMPLE_PARK.id, leagueId: f.leagueA },
          102
        )
      ).status
    ).equals(403)
    expect(
      (
        await f.h.request('POST', '/venues', {
          placeId: EXAMPLE_PARK.id,
          leagueId: 'lea_missing'
        })
      ).status
    ).equals(404)
    expect((await f.h.request('POST', '/venues', 'park')).status).equals(400)
    expect(
      (await f.h.request('POST', '/venues', { leagueId: f.leagueA })).status
    ).equals(400)
    expect(
      (await f.h.request('POST', '/venues', { placeId: EXAMPLE_PARK.id }))
        .status
    ).equals(400)
    expect(
      (await f.h.request('GET', '/venues', undefined, null)).status
    ).equals(401)
    expect((await f.h.request('GET', '/venues/ven_missing')).status).equals(404)
  })

  it('lists the person’s venues first, then claimed ones nearest first, then Google’s places', async () => {
    const venue = await claim()
    f.advance(WEEK)
    // A second claimed venue farther away, and an unclaimed one.
    for (const [id, place, latitude, claimed] of [
      ['ven_far', 'place-far', 41.5, true],
      ['ven_free', 'place-free', 40.03, false]
    ] as const) {
      await f.h.db
        .insertInto('venues')
        .values({
          id,
          google_place_id: place,
          name: `Example Park ${id === 'ven_far' ? 'Far' : 'Free'}`,
          latitude,
          longitude: -75.2,
          timezone: 'America/New_York'
        })
        .execute()
      if (claimed)
        await f.h.db
          .insertInto('venue_claims')
          .values({
            id: `vcl_${id}`,
            venue_id: id,
            league_id: f.leagueB,
            kind: 'claim',
            requested_by: (
              await f.h.db
                .selectFrom('users')
                .select('id')
                .where('is_admin', '=', true)
                .executeTakeFirstOrThrow()
            ).id,
            status: 'approved',
            requested_at: new Date(),
            approves_at: new Date(Date.now() + WEEK),
            decided_at: new Date()
          })
          .execute()
    }
    const nearby = await list('?near=40,-75.2')
    expect(nearby.map(item => item.id)).deep.equals([venue.id, 'ven_far'])
    expect(nearby.map(item => item.group)).deep.equals(['yours', 'claimed'])
    expect(nearby[0].owners.map(owner => owner.name)).deep.equals([
      'Demo League A'
    ])
    expect(nearby[1].distanceKm).equals(
      Math.round(
        distanceKm(
          { latitude: 40, longitude: -75.2 },
          { latitude: 41.5, longitude: -75.2 }
        ) * 10
      ) / 10
    )
    // To user 102, whose league owns the far one, that one leads.
    expect((await list('', 102)).map(item => item.id)).deep.equals([
      'ven_far',
      venue.id
    ])
    const searched = await list('?query=Example%20Park')
    // The registry's three, then Google's other eleven parks.
    expect(searched.map(item => item.id ?? item.placeId)).deep.equals([
      venue.id,
      'ven_far',
      'ven_free',
      ...MORE_PARKS.map(name => name.toLowerCase().replace(' ', '-'))
    ])
    expect(searched.slice(3).map(item => item.name)).deep.equals(MORE_PARKS)
    // The search finds Example Park at Google too, but lists it once.
    expect(searched.filter(item => item.placeId === EXAMPLE_PARK.id)).length(1)
    const asked = stub.calls.filter(
      call => call.path === '/v1/places:searchText'
    )
    expect(asked.at(-1)!.body).deep.equals({
      textQuery: 'Example Park',
      languageCode: 'en',
      pageSize: 20
    })
    // From a point, Google is asked for places near it.
    expect(await list('?query=Example%20Park&near=40,-75.2')).length(14)
    expect(stub.calls.at(-1)!.body).deep.equals({
      textQuery: 'Example Park',
      languageCode: 'en',
      pageSize: 20,
      locationBias: {
        circle: { center: { latitude: 40, longitude: -75.2 }, radius: 50000 }
      }
    })
    const harbor = await list('?query=Harbor')
    expect(
      harbor.map(item => [item.id, item.placeId, item.claimed])
    ).deep.equals([[null, 'harbor-field', false]])
    expect(
      (await list(`?league=${f.leagueB}`)).map(item => item.id)
    ).deep.equals(['ven_far'])
    // When Google is down the registry still answers.
    stub.controls.fail = true
    expect(
      (await list('?query=Example%20Park')).map(item => item.id)
    ).deep.equals([venue.id, 'ven_far', 'ven_free'])
    for (const bad of [
      '?near=40',
      '?near=north',
      '?near=91,0',
      `?place=${EXAMPLE_PARK.id}&query=x`,
      '?query=a&query=b'
    ])
      expect((await f.h.request('GET', `/venues${bad}`)).status, bad).equals(
        400
      )
  })

  it('runs a claim through co-ownership, decisions, leaving and removal', async () => {
    const venue = await claim()
    const id = venue.id!
    f.advance(WEEK)
    // Reading the venue settles the claim that matured.
    const owned = await json<VenueDetail>(
      await f.h.request('GET', `/venues/${id}`)
    )
    expect(owned.owners.map(owner => owner.name)).deep.equals(['Demo League A'])
    const requested = await json<VenueDetail>(
      await f.h.request(
        'POST',
        `/venues/${id}/claims`,
        { leagueId: f.leagueB },
        102
      ),
      201
    )
    const request = requested.claims.find(c => c.leagueId === f.leagueB)!
    expect(request.kind).equals('coOwner')
    expect(
      (await json<VenueDetail>(await f.h.request('GET', `/venues/${id}`)))
        .rights.decidableClaimIds
    ).deep.equals([request.id])
    expect(
      (
        await f.h.request(
          'POST',
          `/venues/${id}/claims/${request.id}/decisions`,
          { decision: 'maybe' }
        )
      ).status
    ).equals(400)
    const declined = await json<VenueDetail>(
      await f.h.request(
        'POST',
        `/venues/${id}/claims/${request.id}/decisions`,
        {
          decision: 'reject'
        }
      )
    )
    expect(declined.claims.map(c => c.leagueId)).deep.equals([f.leagueA])
    const second = await json<VenueDetail>(
      await f.h.request(
        'POST',
        `/venues/${id}/claims`,
        { leagueId: f.leagueB },
        102
      ),
      201
    )
    const secondId = second.claims.find(c => c.leagueId === f.leagueB)!.id
    const approved = await json<VenueDetail>(
      await f.h.request(
        'POST',
        `/venues/${id}/claims/${secondId}/decisions`,
        { decision: 'approve' },
        105
      )
    )
    expect(approved.owners.map(owner => owner.name)).deep.equals([
      'Demo League A',
      'Demo League B'
    ])
    const leagueAClaim = approved.owners[0].claimId
    const left = await json<VenueDetail>(
      await f.h.request('DELETE', `/venues/${id}/claims/${leagueAClaim}`)
    )
    expect(left.owners.map(owner => owner.name)).deep.equals(['Demo League B'])
    expect(
      (
        await f.h.request(
          'DELETE',
          `/venues/${id}/claims/${secondId}`,
          undefined,
          104
        )
      ).status
    ).equals(403)
    const removed = await json<VenueDetail>(
      await f.h.request(
        'DELETE',
        `/venues/${id}/claims/${secondId}`,
        undefined,
        105
      )
    )
    expect(removed.owners).deep.equals([])
    expect(removed.rights.canClaim).equals(false) // 105 runs no league
    expect(
      (await json<VenueDetail>(await f.h.request('GET', `/venues/${id}`)))
        .rights.canClaim
    ).equals(true)
    expect(
      (await f.h.request('POST', `/venues/${id}/claims`, 'league')).status
    ).equals(400)
  })

  it('edits a venue and its fields for an owner, softly deletes a field, and stores photos wide', async () => {
    const venue = await claim()
    const id = venue.id!
    expect(
      (
        await f.h.request(
          'PUT',
          `/venues/${id}`,
          { sizeSwitchMinutes: 30 },
          102
        )
      ).status
    ).equals(403)
    const edited = await json<VenueDetail>(
      await f.h.request('PUT', `/venues/${id}`, {
        name: 'Example Park North',
        sizeSwitchMinutes: 30,
        defaultHours: [
          { weekday: 6, start: '08:00', end: '18:00' },
          { weekday: 2, start: '17:00', end: '21:00' }
        ],
        defaultBlackouts: ['2027-07-04'],
        photo: accountTestPicture
      })
    )
    expect(edited).include({
      name: 'Example Park North',
      sizeSwitchMinutes: 30
    })
    expect(edited.defaultHours.map(h => h.weekday)).deep.equals([2, 6])
    expect(edited.defaultBlackouts).deep.equals(['2027-07-04'])
    expect(edited.photoUrl).includes('-640.png')
    expect(edited.photoLargeUrl).includes('-1280.png')
    for (const bad of [
      { sizeSwitchMinutes: 241 },
      { defaultHours: [{ weekday: 6, start: '08:03', end: '18:00' }] },
      { defaultBlackouts: ['2027-02-30'] },
      { name: '' }
    ])
      expect(
        (await f.h.request('PUT', `/venues/${id}`, bad)).status,
        JSON.stringify(bad)
      ).equals(400)
    expect(
      (
        await f.h.request('PUT', `/venues/${id}`, {
          photo: { contentType: 'image/gif', base64: 'AAAA' }
        })
      ).status
    ).equals(415)
    const withField = await json<VenueDetail>(
      await f.h.request('POST', `/venues/${id}/fields`, {
        name: 'Field 1',
        sizes: ['50/70', '46/60'],
        pin: { latitude: 40.021, longitude: -75.221 },
        startsOn: '2026-10-01',
        endsOn: '2027-09-30',
        photo: accountTestPicture
      }),
      201
    )
    const field = withField.fields[0]
    expect(field).include({ name: 'Field 1', startsOn: '2026-10-01' })
    expect(field.sizes).deep.equals(['46/60', '50/70'])
    expect(field.hours).equals(null)
    expect(field.photoUrl).includes('-640.png')
    for (const bad of [
      { name: 'Field 2', sizes: [] },
      { name: 'Field 2', sizes: ['70/100'] },
      { name: 'Field 2', sizes: ['50/70'], pin: { latitude: 40 } },
      {
        name: 'Field 2',
        sizes: ['50/70'],
        startsOn: '2027-09-30',
        endsOn: '2026-10-01'
      },
      { sizes: ['50/70'] }
    ])
      expect(
        (await f.h.request('POST', `/venues/${id}/fields`, bad)).status,
        JSON.stringify(bad)
      ).equals(400)
    const changed = await json<VenueDetail>(
      await f.h.request('PUT', `/venues/${id}/fields/${field.id}`, {
        hours: [{ weekday: 6, start: '08:00', end: '22:00' }],
        blackouts: ['2027-04-17'],
        pin: null,
        photo: accountTestPicture
      })
    )
    expect(changed.fields[0].hours).deep.equals([
      { weekday: 6, start: '08:00', end: '22:00' }
    ])
    expect(changed.fields[0].pin).equals(null)
    expect(changed.fields[0].blackouts).deep.equals(['2027-04-17'])
    const unchanged = await json<VenueDetail>(
      await f.h.request('PUT', `/venues/${id}/fields/${field.id}`, {})
    )
    expect(unchanged.fields[0].hours).deep.equals(changed.fields[0].hours)
    expect(
      (
        await f.h.request('PUT', `/venues/${id}/fields/fld_missing`, {
          name: 'x'
        })
      ).status
    ).equals(404)
    expect(
      (
        await f.h.request(
          'DELETE',
          `/venues/${id}/fields/${field.id}`,
          undefined,
          102
        )
      ).status
    ).equals(403)
    const deleted = await json<VenueDetail>(
      await f.h.request('DELETE', `/venues/${id}/fields/${field.id}`)
    )
    expect(deleted.fields).deep.equals([])
    const kept = await f.h.db
      .selectFrom('venue_fields')
      .select(['id', 'deleted_at'])
      .executeTakeFirstOrThrow()
    expect(kept.id).equals(field.id)
    expect(kept.deleted_at).not.equals(null)
    expect(
      (await f.h.request('DELETE', `/venues/${id}/fields/${field.id}`)).status
    ).equals(404)
  })
})

describe('venue routes without a place provider', function () {
  this.timeout(120000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  it('answers 503 for Google places and lists the registry alone', async () => {
    expect(
      (
        await f.h.request('POST', '/venues', {
          placeId: EXAMPLE_PARK.id,
          leagueId: f.leagueA
        })
      ).status
    ).equals(503)
    expect(
      (await f.h.request('GET', `/venues?place=${EXAMPLE_PARK.id}`)).status
    ).equals(503)
    const response = await f.h.request('GET', '/venues?query=Example')
    expect(response.status).equals(200)
    expect(((await response.json()) as { items: unknown[] }).items).deep.equals(
      []
    )
  })
})
