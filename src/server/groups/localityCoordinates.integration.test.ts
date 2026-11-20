import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import type { Locality } from '../../common/locality'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'

/**
 * A league's or team's coordinates follow its locality: creating one with a
 * catalog city stores that city's, and every later change of its locality
 * replaces them, or clears them for a city the catalog does not hold.
 */

const sanDiego: Locality = {
  city: 'San Diego',
  region: 'California',
  country: 'US',
  placeId: '5391811',
  timezone: 'America/Los_Angeles'
}
const sanDiegoTexas: Locality = {
  city: 'San Diego',
  region: 'Texas',
  country: 'US',
  placeId: 'geonames:4726311',
  timezone: 'America/Chicago'
}

describe('group coordinates written with their locality', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })

  const coordinates = async (
    table: 'leagues' | 'teams',
    id: string
  ): Promise<unknown> =>
    await f.h.db
      .selectFrom(table)
      .select(['latitude', 'longitude'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const create = async (
    route: '/leagues' | '/teams',
    name: string
  ): Promise<string> => {
    const response = await f.h.request('POST', route, {
      name,
      locality: sanDiego,
      idempotencyKey: `coordinates-${name}`
    })
    expect(response.status, await response.clone().text()).equals(201)
    return ((await response.json()) as { id: string }).id
  }

  it('stores the catalog city’s coordinates when a league or team is created', async () => {
    const league = await create('/leagues', 'Demo Coast League')
    const team = await create('/teams', 'Demo Coast Hawks')
    const expected = { latitude: 32.71571, longitude: -117.16472 }
    expect(await coordinates('leagues', league)).deep.equals(expected)
    expect(await coordinates('teams', team)).deep.equals(expected)
    // The fixture's groups sit in a city the catalog does not hold.
    expect(await coordinates('leagues', f.leagueA)).deep.equals({
      latitude: null,
      longitude: null
    })
  })

  it('replaces them with a new locality, and clears them for an unknown city', async () => {
    for (const kind of ['league', 'team'] as const) {
      const id = kind === 'league' ? f.leagueA : f.teamA
      const table = kind === 'league' ? 'leagues' : 'teams'
      const put = async (locality: Locality): Promise<void> => {
        const response = await f.h.request(
          'PUT',
          `/groups/${kind}/${id}`,
          { locality },
          101
        )
        expect(response.status, await response.text()).equals(200)
      }
      await put(sanDiegoTexas)
      expect(await coordinates(table, id)).deep.equals({
        latitude: 27.76391,
        longitude: -98.2389
      })
      await put(demoLocality)
      expect(await coordinates(table, id)).deep.equals({
        latitude: null,
        longitude: null
      })
      // A change that leaves the locality alone leaves its coordinates too.
      await put(sanDiego)
      const response = await f.h.request(
        'PUT',
        `/groups/${kind}/${id}`,
        { name: kind === 'league' ? 'Demo League A' : 'Demo Hawks' },
        101
      )
      expect(response.status, await response.text()).equals(200)
      expect(await coordinates(table, id)).deep.equals({
        latitude: 32.71571,
        longitude: -117.16472
      })
    }
  })
})
