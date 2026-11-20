import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import type { IpPlace } from '../location/ipPlaces'
import { emptyReach, type SearchReach } from './reach'
import {
  groupPoints,
  homeFirst,
  ipPoint,
  READER_POINTS_MAX,
  type ReaderPoint,
  readerPoints
} from './readerPlace'

const locality = (city: string, region: string): string =>
  JSON.stringify({
    city,
    region,
    country: 'US',
    placeId: null,
    timezone: 'UTC'
  })

const sanDiegoIp: IpPlace = {
  latitude: 32.7157,
  longitude: -117.1611,
  city: 'San Diego',
  region: 'California',
  country: 'US'
}

const point = (
  label: string,
  latitude: number,
  longitude: number
): ReaderPoint => ({
  label,
  latitude,
  longitude
})

describe('where the reader is', function () {
  this.timeout(60000)
  let f: GroupFixture

  before(async () => {
    f = await groupFixture()
    const db = f.h.db
    await db
      .updateTable('teams')
      .set({
        latitude: 32.7157,
        longitude: -117.1611,
        locality: locality('San Diego', 'California')
      })
      .where('id', '=', f.teamA)
      .execute()
    await db
      .updateTable('teams')
      .set({ latitude: null, longitude: null })
      .where('id', '=', f.teamB)
      .execute()
    await db
      .updateTable('leagues')
      .set({
        latitude: 33.4936,
        longitude: -117.1484,
        locality: locality('Temecula', 'California')
      })
      .where('id', '=', f.leagueA)
      .execute()
    await db
      .updateTable('leagues')
      .set({
        latitude: 40.7128,
        longitude: -74.006,
        locality: locality('New York', 'New York')
      })
      .where('id', '=', f.leagueB)
      .execute()
  })

  after(async () => {
    await f?.h.close()
  })

  const reachOf = (
    more: Partial<Record<keyof SearchReach, string[]>>
  ): SearchReach => ({
    ...emptyReach(),
    ...Object.fromEntries(
      Object.entries(more).map(([key, ids]) => [key, new Set(ids)])
    )
  })

  it('reads the places of the reader’s teams and leagues, a season’s from its league, none for a group with no place', async () => {
    const points = await groupPoints(
      f.h.db,
      reachOf({ teamIds: [f.teamA, f.teamB], seasonIds: [f.seasonB] })
    )
    // Demo Tournament is League B's: New York.
    expect(points.map(each => each.label).sort()).deep.equals([
      'New York City, NY',
      'San Diego, CA'
    ])
    const sanDiego = points.find(each => each.label === 'San Diego, CA')!
    expect(sanDiego).deep.include({ region: 'California', country: 'US' })
    expect(await groupPoints(f.h.db, emptyReach())).deep.equals([])
  })

  it('names a group placed through Google as the catalog does', async () => {
    const db = f.h.db
    await db
      .updateTable('teams')
      .set({
        locality: JSON.stringify({
          city: 'San Diego',
          region: 'California',
          country: 'United States',
          placeId: 'ChIJ-google-stand-in',
          timezone: 'America/Los_Angeles'
        })
      })
      .where('id', '=', f.teamA)
      .execute()
    try {
      const [point] = await groupPoints(db, reachOf({ teamIds: [f.teamA] }))
      expect(point).deep.include({
        label: 'San Diego, CA',
        region: 'California',
        country: 'US'
      })
    } finally {
      await db
        .updateTable('teams')
        .set({ locality: locality('San Diego', 'California') })
        .where('id', '=', f.teamA)
        .execute()
    }
  })

  it('puts the reader’s home area first, by how many of their places are near each', async () => {
    const points = await groupPoints(
      f.h.db,
      reachOf({ teamIds: [f.teamA], leagueIds: [f.leagueA, f.leagueB] })
    )
    const home = homeFirst(points).map(each => each.label)
    // San Diego and Temecula are each other's company; New York has none.
    expect(home.at(-1)).equals('New York City, NY')
    expect(home.slice(0, 2)).deep.equals(['San Diego, CA', 'Temecula, CA'])
  })

  it('keeps one point per place, at most twenty', () => {
    const many = Array.from({ length: 30 }, (_, at) => point(`P${at}`, at, at))
    expect(homeFirst([...many, ...many])).length(READER_POINTS_MAX)
    expect(homeFirst([point('A', 1, 1), point('B', 1, 1)])).length(1)
    // A point nothing names is no home area while a named one ties with it.
    expect(homeFirst([point('', 5, 5), point('Z', 50, 50)])[0].label).equals(
      'Z'
    )
    // An IP place with no city is named by its region, one with no country not at all.
    expect(ipPoint({ ...sanDiegoIp, city: '' }).label).equals('California')
    expect(
      ipPoint({ ...sanDiegoIp, city: '', region: '', country: '' }).label
    ).equals('')
  })

  it('is the reader’s groups when they have any, else their address, else nowhere', async () => {
    const db = f.h.db
    const groups = await readerPoints(
      db,
      async () => reachOf({ teamIds: [f.teamA] }),
      () => {
        throw new Error('not asked while there are groups')
      }
    )
    expect(groups.map(each => each.label)).deep.equals(['San Diego, CA'])
    const placeless = await readerPoints(
      db,
      async () => reachOf({ teamIds: [f.teamB] }),
      () => sanDiegoIp
    )
    expect(placeless).deep.equals([ipPoint(sanDiegoIp)])
    expect(ipPoint(sanDiegoIp)).deep.equals({
      latitude: 32.7157,
      longitude: -117.1611,
      label: 'San Diego, CA',
      region: 'California',
      country: 'US'
    })
    expect(await readerPoints(db, null, () => sanDiegoIp)).length(1)
    expect(await readerPoints(db, null, () => null)).deep.equals([])
  })
})
