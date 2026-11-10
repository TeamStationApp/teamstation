import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import type { UmpireLeaderboard } from '../../common/umpireSchedule'
import { UMPIRE_RANK_SYMBOLS } from '../../common/umpireSchedule'
import { userIdOfGumbo } from '../../common/userId'
import { actor, type GroupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import {
  LEADERBOARD_IDLE,
  LEADERBOARD_RANKED,
  seedLeaderboard
} from '../../test/leaderboardFixture'
import { umpireFixture } from '../../test/umpireFixture'
import { openApiDocument } from '../openapi'
import { leaderboard } from './assignments'

describe('umpire leaderboard pages', function () {
  this.timeout(60000)
  let f: GroupFixture
  const admin = 101
  const umpire = LEADERBOARD_RANKED[11].id
  const idle = userIdOfGumbo(LEADERBOARD_IDLE.id)
  // The fixture's own two umpires, 101 and 104, have no games either.
  const total = 15
  const everyone = (): string[] =>
    [...LEADERBOARD_RANKED, LEADERBOARD_IDLE].map(p => userIdOfGumbo(p.id))
  const extras = (): string[] =>
    Array.from({ length: 40 }, (_, i) => userIdOfGumbo(400 + i))

  const raw = async (query: string, user: number): Promise<Response> =>
    await f.h.request(
      'GET',
      `/leagues/${f.leagueA}/umpire-leaderboard${query}`,
      undefined,
      user
    )
  const board = async (
    query: string,
    user = admin
  ): Promise<UmpireLeaderboard> => {
    const response = await raw(query, user)
    expect(response.status).equals(200)
    return (await response.json()) as UmpireLeaderboard
  }

  before(async () => {
    f = await umpireFixture()
    await seedLeaderboard(f)
    // A second credited team, to show the list is not paged.
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonA, team_id: f.teamB, active: true })
      .onConflict(oc => oc.doNothing())
      .execute()
  })
  // A test that changes the league or its people leaves the next one the fixture.
  afterEach(async () => {
    const { db } = f.h
    await db
      .updateTable('leagues')
      .set({ umpire_management: true, umpire_credits: true })
      .where('id', '=', f.leagueA)
      .execute()
    await db
      .updateTable('teams')
      .set({ player_name_privacy: null })
      .where('id', 'in', [f.teamA, f.teamB, f.standaloneTeam])
      .execute()
    await db
      .updateTable('users')
      .set({ disabled_at: null, merged_into: null })
      .where('id', 'in', everyone())
      .execute()
    await db
      .updateTable('users')
      .set({
        first_name: 'Jackie',
        last_name: 'Robinson',
        display_name: 'Jackie Robinson'
      })
      .where('id', '=', idle)
      .execute()
    await db
      .deleteFrom('memberships')
      .where('id', '=', 'mem_board_elsewhere')
      .execute()
    await db
      .deleteFrom('league_umpires')
      .where('league_id', '=', f.leagueA)
      .where('user_id', 'in', extras())
      .execute()
    await db.deleteFrom('users').where('id', 'in', extras()).execute()
    await db
      .insertInto('league_umpires')
      .values(
        everyone().map(id => ({
          league_id: f.leagueA,
          user_id: id,
          granted_by: userIdOfGumbo(admin)
        }))
      )
      .onConflict(oc => oc.doNothing())
      .execute()
  })
  after(async () => {
    await f?.h.close()
  })

  it('answers the top ten with games and no page when no parameter is named', async () => {
    const answer = await board('')
    expect(answer.scheduled.map(p => p.count)).deep.equals([
      12, 11, 10, 9, 8, 7, 6, 5, 4, 3
    ])
    expect(answer.scheduled.map(p => p.symbol)).deep.equals([
      ...UMPIRE_RANK_SYMBOLS
    ])
    expect(answer).not.has.property('page')
    expect(answer.scheduled.map(p => p.userId)).not.includes(idle)
  })

  it('lists the fewest first with order=asc, and the umpires with no games lead', async () => {
    const answer = await board('?order=asc')
    expect(answer.page).deep.equals({
      order: 'asc',
      limit: 50,
      offset: 0,
      total
    })
    expect(answer.scheduled).length(total)
    expect(answer.scheduled.slice(0, 3).map(p => p.count)).deep.equals([
      0, 0, 0
    ])
    expect(answer.scheduled.slice(0, 3).map(p => p.userId)).includes(idle)
    expect(answer.scheduled[total - 1].count).equals(12)
  })

  it('lists the most first with order=desc, and the umpires with no games trail', async () => {
    const answer = await board('?order=desc')
    expect(answer.scheduled[0].count).equals(12)
    expect(answer.scheduled.slice(-3).map(p => p.count)).deep.equals([0, 0, 0])
  })

  it('defaults to most first, 50 at a time, from the start', async () => {
    expect((await board('?offset=0')).page).deep.equals({
      order: 'desc',
      limit: 50,
      offset: 0,
      total
    })
  })

  it('declares no OpenAPI default, because naming one asks for a page', () => {
    const paths = openApiDocument('').paths as Record<
      string,
      { get: { parameters: Array<{ in: string; schema: object }> } }
    >
    const query = paths[
      '/leagues/{leagueId}/umpire-leaderboard'
    ].get.parameters.filter(p => p.in === 'query')
    expect(query).length(3)
    for (const p of query) expect(p.schema).not.has.property('default')
  })

  it('walks to the end in pages with no overlap or gap', async () => {
    for (const order of ['asc', 'desc']) {
      const whole = (await board(`?order=${order}`)).scheduled.map(
        p => p.userId
      )
      const walked: string[] = []
      for (let offset = 0; offset < total; offset += 2) {
        const page = await board(`?order=${order}&limit=2&offset=${offset}`)
        expect(page.scheduled.length).lessThan(3)
        expect(page.page?.total).equals(total)
        walked.push(...page.scheduled.map(p => p.userId))
      }
      expect(walked).deep.equals(whole)
    }
  })

  it('answers empty lists and the real total past the end', async () => {
    const answer = await board('?offset=1000')
    expect(answer.scheduled).length(0)
    expect(answer.completed).length(0)
    expect(answer.page?.total).equals(total)
  })

  it('ranks completed games on the same people', async () => {
    const answer = await board('?order=asc')
    expect(answer.completed).length(total)
    expect(answer.completed[0].count).equals(0)
    expect((await board('?order=desc')).completed[0].count).equals(6)
  })

  it('breaks ties by name, then id, in both directions', async () => {
    // Only six games are final, so everyone with six or more games ties on six.
    const names = (
      list: UmpireLeaderboard['completed'],
      count: number
    ): string[] => list.filter(p => p.count === count).map(p => p.name)
    const tied = (await board('')).completed
      .filter(p => p.count === 6)
      .map(p => p.name)
    expect(tied).length(7)
    expect(names((await board('?order=desc')).completed, 6)).deep.equals(tied)
    expect(names((await board('?order=asc')).completed, 6)).deep.equals(tied)
    const zero = names((await board('?order=asc')).scheduled, 0)
    expect(zero).deep.equals([...zero].sort((a, b) => a.localeCompare(b)))
    expect(names((await board('?order=desc')).scheduled, 0)).deep.equals(zero)
  })

  it('gives symbols only to the real top ten, in either direction and on any page', async () => {
    const symbols = new Map(
      (await board('')).scheduled.map(p => [p.userId, p.symbol])
    )
    for (const query of ['?order=asc', '?order=desc', '?limit=3&offset=8']) {
      for (const p of (await board(query)).scheduled)
        expect(p.symbol).equals(symbols.get(p.userId) ?? '')
    }
    const fewest = (await board('?order=asc')).scheduled
    expect(fewest.slice(0, 5).every(p => p.symbol === '')).equals(true)
    expect(fewest[total - 1].symbol).equals(UMPIRE_RANK_SYMBOLS[0])
  })

  it('accepts a limit of 50 and reads team credits unpaged, or null with credits off', async () => {
    const answer = await board('?limit=50')
    expect(answer.page?.limit).equals(50)
    const paged = await board('?limit=1')
    expect(paged.teams).deep.equals((await board('')).teams)
    expect(paged.teams?.length).greaterThan(1)
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_credits: false })
      .where('id', '=', f.leagueA)
      .execute()
    expect((await board('?limit=1')).teams).equals(null)
  })

  it('refuses invalid values before access', async () => {
    for (const query of [
      '?order=up',
      '?order=',
      '?limit=0',
      '?limit=51',
      '?limit=1.5',
      '?limit=abc',
      '?offset=-1',
      '?offset=99999999999999999999',
      '?limit=1&limit=2',
      '?order=asc&order=desc'
    ])
      expect((await raw(query, admin)).status, query).equals(400)
    expect((await raw('?limit=51', umpire)).status).equals(400)
  })

  it('keeps the top ten open to an umpire and the pages to an administrator', async () => {
    expect((await raw('', umpire)).status).equals(200)
    for (const query of ['?order=asc', '?limit=5', '?offset=1'])
      expect((await raw(query, umpire)).status, query).equals(403)
  })

  it('refuses someone who is no umpire, nobody, and a league with management off', async () => {
    const stranger = 102
    expect((await raw('?limit=5', stranger)).status).equals(403)
    expect(
      (
        await fetch(
          `${f.h.origin}/api/v1/leagues/${f.leagueA}/umpire-leaderboard?limit=5`
        )
      ).status
    ).equals(401)
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_management: false })
      .where('id', '=', f.leagueA)
      .execute()
    expect((await raw('?limit=5', admin)).status).equals(403)
  })

  it('leaves out a disabled umpire with no games and keeps one with games', async () => {
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', 'in', [idle, userIdOfGumbo(umpire)])
      .execute()
    const ids = (await board('?order=asc')).scheduled.map(p => p.userId)
    expect(ids).not.includes(idle)
    expect(ids).includes(userIdOfGumbo(umpire))
  })

  it('keeps a removed umpire with games and leaves out one without', async () => {
    const withGames = userIdOfGumbo(LEADERBOARD_RANKED[11].id)
    await f.h.db
      .deleteFrom('league_umpires')
      .where('league_id', '=', f.leagueA)
      .where('user_id', 'in', [idle, withGames])
      .execute()
    const answer = await board('?order=asc')
    const ids = answer.scheduled.map(p => p.userId)
    expect(ids).includes(withGames)
    expect(ids).not.includes(idle)
    expect(answer.page?.total).equals(total - 1)
  })

  const rosterNames = async (): Promise<Map<string, string>> => {
    const roster = (await (
      await f.h.request('GET', `/leagues/${f.leagueA}/umpires`)
    ).json()) as { people: Array<{ id: string; name: string }> }
    return new Map(roster.people.map(p => [p.id, p.name]))
  }
  const expectRosterNames = async (): Promise<void> => {
    const names = await rosterNames()
    for (const p of (await board('?order=asc')).scheduled)
      expect(p.name).equals(names.get(p.userId))
  }

  it('names everyone as the roster does, under a stricter format', async () => {
    const child = userIdOfGumbo(104)
    const pageName = async (): Promise<string | undefined> =>
      (await board('?order=asc')).scheduled.find(p => p.userId === child)?.name
    const loose = await pageName()
    await f.h.db
      .updateTable('teams')
      .set({ player_name_privacy: 'initials' })
      .where('id', '=', f.teamA)
      .execute()
    expect(await pageName()).not.equals(loose)
    await expectRosterNames()
  })

  it('names everyone as the roster does, through a collision', async () => {
    await f.h.db
      .updateTable('users')
      .set({
        first_name: 'Hank',
        last_name: 'Allen',
        display_name: 'Hank Allen'
      })
      .where('id', '=', idle)
      .execute()
    const aaron = userIdOfGumbo(LEADERBOARD_RANKED[0].id)
    const { scheduled } = await board('?order=asc')
    expect(scheduled.find(p => p.userId === idle)?.name).not.equals(
      scheduled.find(p => p.userId === aaron)?.name
    )
    await expectRosterNames()
  })

  it('names a person as the roster does when they play in another league', async () => {
    const hank = userIdOfGumbo(LEADERBOARD_RANKED[0].id)
    await f.h.db
      .updateTable('teams')
      .set({ player_name_privacy: 'full' })
      .where('id', '=', f.standaloneTeam)
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_board_elsewhere',
        team_id: f.standaloneTeam,
        user_id: hank,
        is_player: true,
        role: 'member'
      })
      .execute()
    await expectRosterNames()
  })

  it('gives the same people symbols on a page as on the default read, under a stricter format', async () => {
    // Seven tie on six final games, and initials reorder one of their names.
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_board_elsewhere',
        team_id: f.teamA,
        user_id: userIdOfGumbo(LEADERBOARD_RANKED[6].id),
        is_player: true,
        role: 'member'
      })
      .execute()
    await f.h.db
      .updateTable('teams')
      .set({ player_name_privacy: 'initials' })
      .where('id', '=', f.teamA)
      .execute()
    const symbols = new Map(
      (await board('')).completed.map(p => [p.userId, p.symbol])
    )
    for (const p of (await board('?order=desc')).completed)
      expect(p.symbol).equals(symbols.get(p.userId) ?? '')
    const page = (await board('?order=desc&limit=10')).completed
    expect(page.map(p => p.symbol)).deep.equals([...UMPIRE_RANK_SYMBOLS])
  })

  it('adds no query for each more roster umpire with no games', async () => {
    let queries = 0
    const db = f.h.db.withPlugin({
      transformQuery({ node }) {
        queries += 1
        return node
      },
      async transformResult({ result }) {
        return result
      }
    })
    await leaderboard(db, actor(admin), f.leagueA, { limit: 1 })
    const few = queries
    await insertFixtureUsers(
      f.h.db,
      Array.from({ length: 40 }, (_, i) => ({
        id: 400 + i,
        legacyId: `usr_board_${400 + i}`,
        display_name: `Cy Young${i}`,
        first_name: 'Cy',
        last_name: `Young${i}`
      }))
    )
    await f.h.db
      .insertInto('league_umpires')
      .values(
        extras().map(id => ({
          league_id: f.leagueA,
          user_id: id,
          granted_by: userIdOfGumbo(admin)
        }))
      )
      .execute()
    queries = 0
    await leaderboard(db, actor(admin), f.leagueA, { limit: 1 })
    expect(queries).equals(few)
  })

  it('counts a merged roster account once, as the survivor', async () => {
    const survivor = userIdOfGumbo(LEADERBOARD_RANKED[0].id)
    await f.h.db
      .updateTable('users')
      .set({ merged_into: survivor })
      .where('id', '=', idle)
      .execute()
    const answer = await board('?order=desc')
    expect(answer.page?.total).equals(total - 1)
    const ids = answer.scheduled.map(p => p.userId)
    expect(ids).not.includes(idle)
    expect(ids.filter(id => id === survivor)).length(1)
  })
})
