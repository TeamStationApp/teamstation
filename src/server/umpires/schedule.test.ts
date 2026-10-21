import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  hardUmpireConflict,
  softUmpireConflict,
  umpireCloseness,
  umpireDate,
  umpireEnd,
  umpireFilterError,
  umpireTimeMatches,
  umpireWindowsOverlap
} from '../../common/umpireTime'
import { userIdOfGumbo } from '../../common/userId'
import { actor, type GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { now } from '../clock'
import { umpireIdentity, umpireIsPlaying } from './context'
import { parseUmpireFilters, schedule } from './schedule'

describe('umpire time and conflict rules', () => {
  const game = {
    startAt: '2027-04-03T00:00:00Z',
    endAt: '2027-04-03T02:00:00Z'
  }
  const interval = (
    a: string,
    b: string
  ): { startAt: string; endAt: string } => ({
    startAt: `2027-04-${a}`,
    endAt: `2027-04-${b}`
  })
  it('uses half-open hard intervals and inclusive soft buffers', () => {
    for (const other of [
      interval('02T21:50:00Z', '02T23:50:00Z'),
      interval('03T02:30:00Z', '03T04:00:00Z'),
      interval('02T22:00:00Z', '03T00:00:00Z')
    ]) {
      expect(softUmpireConflict(game, other)).equals(true)
      expect(hardUmpireConflict(game, other)).equals(false)
    }
    expect(
      hardUmpireConflict(game, interval('02T22:00:00Z', '03T00:01:00Z'))
    ).equals(true)
    expect(
      softUmpireConflict(game, interval('04T00:00:00Z', '04T02:00:00Z'))
    ).equals(false)
    expect(
      umpireEnd({ ...game, endAt: null }) - Date.parse(game.startAt)
    ).equals(3 * 3600000)
    expect(umpireCloseness(game, game)).equals('overlaps this game')
    expect(
      umpireCloseness(game, interval('02T21:50:00Z', '02T23:50:00Z'))
    ).equals('ends 10 minutes before this game starts')
    expect(
      umpireCloseness(game, interval('03T02:30:00Z', '03T04:00:00Z'))
    ).equals('starts 30 minutes after this game ends')
  })
  it('formats fixed English and filters by game-local weekday and time', () => {
    expect(
      umpireDate('2026-09-26T17:00:00-07:00', 'America/Los_Angeles')
    ).equals('Sep 26, 5:00 pm')
    expect(
      umpireTimeMatches(game.startAt, 'America/Los_Angeles', {
        days: [4],
        from: '17:00',
        to: '18:00'
      })
    ).equals(true)
    expect(umpireTimeMatches(game.startAt, 'UTC', { days: [4] })).equals(false)
    expect(umpireTimeMatches(game.startAt, 'UTC', { from: '17:00' })).equals(
      true
    )
    expect(
      umpireTimeMatches(game.startAt, 'UTC', { from: '17:00', to: '18:00' })
    ).equals(false)
    expect(umpireFilterError({ from: '17:00', to: '17:00' })).equals(
      'End time must be after start time.'
    )
    expect(umpireFilterError({ from: '27:00' })).not.equals(null)
    expect(umpireFilterError({ days: [7] })).not.equals(null)
    expect(umpireFilterError({})).equals(null)
    expect(
      umpireWindowsOverlap(
        { start: '2027-01-01', end: '2027-04-01' },
        { start: '2027-03-01', end: '2027-06-01' }
      )
    ).equals(true)
    expect(
      umpireWindowsOverlap(
        { start: '2026-01-01', end: '2026-04-01' },
        { start: '2027-03-01', end: '2027-06-01' }
      )
    ).equals(false)
    expect(parseUmpireFilters({ days: '0,6', levels: 'a,b' })).includes({
      from: undefined,
      to: undefined
    })
    for (const query of [
      { days: [{}] },
      { from: [] },
      { to: {} },
      { levels: {} }
    ])
      expect(() => parseUmpireFilters(query)).throws()
    expect(
      parseUmpireFilters({ days: ['0', '6'], levels: ['a', 'b'] })
    ).deep.equals({
      days: [0, 6],
      levels: ['a', 'b'],
      from: undefined,
      to: undefined
    })
    const old = process.env.TS_UMPIRE_NOW
    delete process.env.TS_UMPIRE_NOW
    expect(now()).closeTo(Date.now(), 1000)
    process.env.TS_UMPIRE_NOW = 'bad'
    expect(() => now()).throws()
    if (old == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = old
  })
})
describe('umpire schedule involvement and availability', function () {
  this.timeout(60000)
  let f: GroupFixture
  let old: string | undefined
  const get = async (query = 'view=umpire', user = 101): Promise<Response> =>
    await f.h.request(
      'GET',
      `/leagues/${f.leagueA}/umpire-schedule?${query}`,
      undefined,
      user
    )
  before(async () => {
    old = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
  })
  after(async () => {
    await f?.h.close()
    if (old == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = old
  })
  it('shows the role league and current-window game with player conflict and eligibility reasons', async () => {
    expect(
      (
        await (
          await f.h.request('GET', '/me/umpire-leagues', undefined, 101)
        ).json()
      ).leagues
    ).length(1)
    const response = await get()
    expect(response.status).equals(200)
    const body = await response.json()
    expect(body.games).length(1)
    expect(body.games[0].date).equals('Apr 2, 5:00 pm')
    expect(body.games[0].conflicts[0].activity).equals('playing')
    expect(body.games[0].choices.plate[0].reason).equals(null)
    expect(body.games[0].choices.plate[1].reason).equals('already playing then')
    expect(body.creditTeams.map((t: any) => t.id)).includes(f.teamA)
    expect((await get('view=league', 102)).status).equals(403)
    expect((await get('view=wrong')).status).equals(400)
    expect((await get('from=18:00&to=17:00')).status).equals(400)
    expect((await (await get('days=0')).json()).games).length(0)
    expect((await (await get('levels=missing')).json()).games).length(0)
    expect((await (await get('levels=ulv_majors')).json()).games).length(1)
  })
  it('accepts repeated collection filters and excludes disabled canonical children', async () => {
    const filtered = await get('days=0&days=4&levels=missing&levels=ulv_majors')
    expect(filtered.status).equals(200)
    expect((await filtered.json()).games).length(1)
    const child = userIdOfGumbo(104)
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', child)
      .execute()
    try {
      const body = await (await get()).json()
      expect(
        body.games[0].choices.plate.some((p: any) => p.userId === child)
      ).equals(false)
    } finally {
      await f.h.db
        .updateTable('users')
        .set({ disabled_at: null })
        .where('id', '=', child)
        .execute()
    }
  })
  it('matches guest and unrostered Gumbo IDs rather than user IDs', async () => {
    const child = await umpireIdentity(f.h.db, userIdOfGumbo(104))
    const game = await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', 'gam_umpire')
      .executeTakeFirstOrThrow()
    expect(umpireIsPlaying(child, game)).equals(true)
    expect(
      umpireIsPlaying(child, {
        ...game,
        unrostered: { home: child.gumboIds, away: [] }
      })
    ).equals(false)
    expect(
      umpireIsPlaying(
        { ...child, teamIds: [] },
        { ...game, guests: { away: child.gumboIds, home: [] } }
      )
    ).equals(true)
    expect(umpireIsPlaying({ ...child, gumboIds: [] }, game)).equals(true)
  })
  it('keeps role-only people outside involvement windows and disables reads when management is off', async () => {
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueA,
        user_id: userIdOfGumbo(103),
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    expect((await (await get('view=umpire', 103)).json()).games).length(0)
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_management: false })
      .where('id', '=', f.leagueA)
      .execute()
    expect((await get()).status).equals(403)
    expect(
      (
        await (
          await f.h.request('GET', '/me/umpire-leagues', undefined, 101)
        ).json()
      ).leagues
    ).length(0)
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_management: true })
      .where('id', '=', f.leagueA)
      .execute()
  })
  it('omits zero needs, cancelled and withdrawn games, and keeps admin-only full visibility', async () => {
    await f.h.db
      .updateTable('season_umpire_requirements')
      .set({ plate: false, field_count: 0 })
      .where('season_id', '=', f.seasonA)
      .execute()
    expect((await (await get()).json()).games).length(0)
    await f.h.db
      .updateTable('season_umpire_requirements')
      .set({ plate: true, field_count: 1 })
      .where('season_id', '=', f.seasonA)
      .execute()
    for (const patch of [
      { status: 'cancelled' as const },
      { status: 'scheduled' as const, withdrawn_at: new Date() }
    ]) {
      await f.h.db
        .updateTable('games')
        .set(patch)
        .where('id', '=', 'gam_umpire')
        .execute()
      expect((await (await get()).json()).games).length(0)
    }
    await f.h.db
      .updateTable('games')
      .set({
        withdrawn_at: null,
        status: 'final',
        start_at: new Date('2027-03-01T00:00:00Z')
      })
      .where('id', '=', 'gam_umpire')
      .execute()
    expect((await (await get()).json()).games).length(1)
    await f.h.db
      .deleteFrom('league_umpires')
      .where('user_id', '=', userIdOfGumbo(101))
      .execute()
    expect((await get()).status).equals(403)
    expect((await (await get('view=league')).json()).games).length(1)
  })
})

describe('umpire schedule author query bounds', function () {
  this.timeout(60000)
  it('bounds identity queries and commitment scans over 1,000 games and merged authors', async () => {
    const f = await umpireFixture()
    const previous = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    try {
      await f.h.db
        .updateTable('users')
        .set({ merged_into: userIdOfGumbo(106) })
        .where('id', '=', userIdOfGumbo(102))
        .execute()
      const games = Array.from({ length: 1000 }, (_, i) => ({
        id: `gam_authors_${i}`,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date(
          Date.parse('2026-01-01T12:00:00Z') + i * 24 * 3600000
        )
      }))
      await f.h.db.insertInto('games').values(games).execute()
      await f.h.db
        .insertInto('umpire_assignments')
        .values(
          games.map((g, i) => ({
            game_id: g.id,
            slot: 'plate',
            user_id: userIdOfGumbo(104),
            assigned_by: userIdOfGumbo(i % 2 === 0 ? 102 : 106)
          }))
        )
        .execute()
      let queries = 0
      let assignmentReads = 0
      let rosterReads = 0
      const db = f.h.db.withPlugin({
        transformQuery({ node }) {
          queries++
          return node
        },
        async transformResult({ result }) {
          for (const row of result.rows as Array<Record<string, unknown>>) {
            const key =
              'slot' in row
                ? 'user_id'
                : 'home_team_id' in row
                  ? 'home_team_id'
                  : null
            if (key == null) continue
            const value = row[key]
            Object.defineProperty(row, key, {
              enumerable: true,
              get() {
                if (key === 'user_id') assignmentReads++
                else rosterReads++
                return value
              }
            })
          }
          return result
        }
      })
      const started = performance.now()
      const result = await schedule(db, actor(101), f.leagueA, 'league', {})
      expect(result.games).length(1001)
      for (const game of result.games.filter(g =>
        g.id.startsWith('gam_authors_')
      ))
        expect(game.assignments.plate?.assignedBy).equals(userIdOfGumbo(106))
      expect(queries).lessThan(80)
      expect(assignmentReads).lessThan(20000)
      expect(rosterReads).lessThan(20000)
      console.log(
        `1,001-game schedule: ${Math.round(performance.now() - started)}ms; ${assignmentReads} assignment reads; ${rosterReads} roster reads`
      )
    } finally {
      await f.h.close()
      if (previous == null) delete process.env.TS_UMPIRE_NOW
      else process.env.TS_UMPIRE_NOW = previous
    }
  })
})
