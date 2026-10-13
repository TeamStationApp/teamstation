import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { monthsBefore } from './relatedTeams'

const farLocality = { ...demoLocality, city: 'Far City', region: 'Far Region' }

interface Row {
  id: string
  name: string
  external: boolean
  seasonNames?: string[]
  staffNames?: string[]
}

describe('team suggestions and search rows', function () {
  this.timeout(60000)
  let f: GroupFixture
  let key = 0
  const ids: Record<string, string> = {}
  const create = async (
    name: string,
    userId: number,
    body: Record<string, unknown> = { locality: demoLocality }
  ): Promise<string> => {
    const result = await f.h.request(
      'POST',
      '/teams',
      { name, idempotencyKey: `related-${++key}`, ...body },
      userId
    )
    expect(result.status, await result.clone().text()).equals(201)
    return ((await result.json()) as { id: string }).id
  }
  const game = async (
    opponent: string,
    startAt: Date,
    status: 'final' | 'cancelled' = 'final'
  ): Promise<void> => {
    await f.h.db
      .insertInto('games')
      .values({
        id: makeId('game'),
        home_team_id: f.teamA,
        away_team_id: opponent,
        season_id: null,
        start_at: startAt,
        venue: 'Demo Field',
        status
      })
      .execute()
  }
  const get = async (path: string): Promise<Row[]> => {
    const response = await f.h.request('GET', path, undefined, null)
    expect(response.status, path).equals(200)
    return (await response.json()) as Row[]
  }
  before(async () => {
    f = await groupFixture()
    const now = f.clock.now()
    ids.owls = await create('Demo Owls', 101, {
      locality: demoLocality,
      parent: { kind: 'season', id: f.seasonA }
    })
    ids.kestrels = await create('Demo Kestrels', 101, {
      locality: farLocality,
      parent: { kind: 'season', id: f.playoffs }
    })
    ids.falcons = await create('Demo Falcons', 103, { locality: farLocality })
    ids.ravens = await create('Demo Ravens', 103, { locality: farLocality })
    ids.wrens = await create('Demo Wrens', 103, { locality: farLocality })
    ids.herons = await create('Demo Herons', 106, { locality: demoLocality })
    ids.merged = await create('Demo Merged', 101, {
      locality: demoLocality,
      parent: { kind: 'season', id: f.seasonA }
    })
    await f.h.db
      .updateTable('teams')
      .set({ merged_into: ids.owls })
      .where('id', '=', ids.merged)
      .execute()
    // The Owls are in the season and an opponent too: listed once, first.
    await game(ids.owls, monthsBefore(now, 1))
    await game(ids.falcons, monthsBefore(now, 5))
    await game(ids.ravens, monthsBefore(now, 7))
    await game(ids.wrens, monthsBefore(now, 2), 'cancelled')
    // A coach, and somebody given a role who has not named themselves yet.
    await f.h.db
      .updateTable('users')
      .set({ onboarding_step: 'name' })
      .where('id', '=', 106)
      .execute()
    for (const [userId, role] of [
      [104, 'coach'],
      [106, 'assistant']
    ] as const)
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          scope_type: 'team',
          scope_id: ids.owls,
          user_id: userId,
          role,
          granted_by: 101,
          granted_at: new Date()
        })
        .execute()
  })
  after(async () => {
    await f?.h.close()
  })

  it('suggests the same season, the same league, recent opponents, then the region', async () => {
    const rows = await get(`/teams?view=public&relatedTeam=${f.teamA}`)
    const order = rows.map(row => row.id)
    const at = (id: string): number => order.indexOf(id)
    expect(order).not.includes(f.teamA)
    expect(order).not.includes(ids.merged)
    expect(order.filter(id => id === ids.owls)).length(1)
    // Same season, then the league's other seasons, then opponents, then the region.
    expect(at(ids.owls)).equals(0)
    expect(at(ids.kestrels)).greaterThan(at(ids.owls))
    expect(at(ids.falcons)).greaterThan(at(ids.kestrels))
    expect(at(ids.herons)).greaterThan(at(ids.falcons))
    expect(at(f.standaloneTeam)).greaterThan(at(ids.falcons))
    // Seven months is outside the window, and a cancelled game is no game.
    expect(order).not.includes(ids.ravens)
    expect(order).not.includes(ids.wrens)
    const owls = rows[0]
    expect(owls.seasonNames).deep.equals(['Demo Regular'])
    expect(owls.staffNames?.[0]).equals('Ichiro')
    expect(owls.staffNames).not.includes('Staff member')
    expect(owls.staffNames).not.includes('Tim R.')
  })

  it('names the same staff as each team’s own page, inherited roles included', async () => {
    const rows = await get(`/teams?view=public&relatedTeam=${f.teamA}`)
    expect(rows.length).greaterThan(3)
    for (const row of rows) {
      const detail = (await (
        await f.h.request('GET', `/teams/${row.id}`, undefined, null)
      ).json()) as { staff: Array<{ name: string }> }
      expect([...(row.staffNames ?? [])].sort(), row.name).deep.equals(
        detail.staff
          .map(person => person.name)
          .filter(name => name !== 'Staff member')
          .sort()
      )
    }
  })

  it('counts months back within the month', () => {
    expect(
      monthsBefore(new Date('2026-08-31T12:00:00Z'), 6).toISOString()
    ).equals('2026-02-28T12:00:00.000Z')
    expect(
      monthsBefore(new Date('2028-08-31T12:00:00Z'), 6).toISOString()
    ).equals('2028-02-29T12:00:00.000Z')
    expect(
      monthsBefore(new Date('2026-10-06T19:00:00Z'), 5).toISOString()
    ).equals('2026-05-06T19:00:00.000Z')
  })

  it('suggests around a season alone: its teams, then its league', async () => {
    const order = (
      await get(`/teams?view=public&relatedSeason=${f.seasonA}`)
    ).map(row => row.id)
    expect(order.slice(0, 2).sort()).deep.equals([f.teamA, ids.owls].sort())
    expect(order.indexOf(ids.kestrels)).equals(2)
    expect(order).not.includes(ids.falcons)
  })

  it('combines a season with a team and keeps to fifty', async () => {
    await f.h.db
      .insertInto('teams')
      .values(
        Array.from({ length: 60 }, (_, index) => ({
          id: `tem_related_region_${index}`,
          name: `Demo Region ${String(index).padStart(2, '0')}`,
          locality: JSON.stringify(demoLocality)
        }))
      )
      .execute()
    const rows = await get(
      `/teams?view=public&relatedTeam=${ids.owls}&relatedSeason=${f.seasonB}`
    )
    expect(rows).length(50)
    expect(rows[0].id).equals(f.teamB)
    expect(rows.map(row => row.id)).not.includes(ids.owls)
    await f.h.db
      .deleteFrom('teams')
      .where('id', 'like', 'tem_related_region_%')
      .execute()
  })

  it('reads a large league only as far as fifty suggestions reach', async () => {
    const { league_id: leagueId } = await f.h.db
      .selectFrom('seasons')
      .select('league_id')
      .where('id', '=', f.seasonA)
      .executeTakeFirstOrThrow()
    await f.h.db
      .insertInto('teams')
      .values(
        Array.from({ length: 60 }, (_, index) => ({
          id: `tem_related_league_${index}`,
          name: `Demo League Team ${String(index).padStart(2, '0')}`,
          league_id: leagueId,
          locality: JSON.stringify(farLocality)
        }))
      )
      .execute()
    const order = (await get(`/teams?view=public&relatedTeam=${f.teamA}`)).map(
      row => row.id
    )
    expect(order).length(50)
    // The season's own teams still come first, then the league by name.
    expect(order[0]).equals(ids.owls)
    const league = order.filter(id => id.startsWith('tem_related_league_'))
    expect(league.length).greaterThan(40)
    expect(league).deep.equals(
      league.map((_, index) => `tem_related_league_${index}`)
    )
    await f.h.db
      .deleteFrom('teams')
      .where('id', 'like', 'tem_related_league_%')
      .execute()
  })

  it('refuses a suggestion with a search, an unknown anchor or without view=public', async () => {
    const status = async (path: string): Promise<number> =>
      (await f.h.request('GET', path, undefined, 101)).status
    expect(
      await status(`/teams?view=public&relatedTeam=${f.teamA}&query=ea`)
    ).equals(400)
    expect(await status(`/teams?view=public&relatedTeam=tem_missing`)).equals(
      404
    )
    expect(await status(`/teams?view=public&relatedSeason=sea_missing`)).equals(
      404
    )
    expect(await status(`/teams?relatedTeam=${f.teamA}`)).equals(400)
    expect(
      await status(
        `/teams?view=public&relatedTeam=${f.teamA}&relatedTeam=${ids.owls}`
      )
    ).equals(400)
  })

  it('adds seasons and staff to search rows only', async () => {
    const search = await get('/teams?view=public&query=Demo')
    expect(search.map(row => row.name)).deep.equals(
      [...search.map(row => row.name)].sort((a, b) => a.localeCompare(b))
    )
    expect(search.find(row => row.id === ids.owls)?.seasonNames).deep.equals([
      'Demo Regular'
    ])
    const placeholder = await create('Demo Unplaced', 101, {
      external: true,
      custodian: { kind: 'team', id: f.teamA }
    })
    const found = await get('/teams?view=public&query=Unplaced')
    expect(
      found.map(row => [row.id, row.staffNames, row.seasonNames])
    ).deep.equals([[placeholder, [], []]])
    const seasons = await get('/seasons?view=public&query=Demo')
    expect(seasons[0]).not.have.property('seasonNames')
    for (const path of ['/me/groups', '/me/groups?role=admin']) {
      const response = await f.h.request('GET', path, undefined, 101)
      const own = (await response.json()) as Row[]
      expect(own.length, path).greaterThan(0)
      for (const row of own) {
        expect(row, path).not.have.property('seasonNames')
        expect(row, path).not.have.property('staffNames')
      }
    }
  })
})
