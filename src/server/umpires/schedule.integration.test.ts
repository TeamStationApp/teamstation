import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { initialUmpireGame } from '../../common/nextGame'
import { asUmpireSchedule } from '../../common/umpireCleaners'
import {
  optionalPositionHeader,
  type UmpireColumn,
  umpireColumns,
  type UmpireGameRow
} from '../../common/umpireSchedule'
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
import {
  addAcceptanceSeasons,
  freshUmpire,
  grantScopeRole
} from '../../test/umpireAcceptance'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { seedUmpireCounts } from '../../test/umpireTypes'
import { now } from '../clock'
import { readerOf } from '../users/readerNames'
import { umpireIdentity, umpireIsPlaying } from './context'
import { parseUmpireFilters, schedule, umpireSchedulePage } from './schedule'

describe('umpire time and conflict rules', () => {
  it('validates viewer zones and respects DST transitions', () => {
    expect(umpireFilterError({ timezone: 'Not/AZone' })).equals(
      'Choose a valid timezone.'
    )
    expect(umpireFilterError({ timezone: 'America/Los_Angeles' })).equals(null)
    expect(() => parseUmpireFilters({ timezone: ['UTC', 'UTC'] })).throws()
    expect(umpireDate('2027-03-14T09:30:00Z', 'America/Los_Angeles')).equals(
      'Mar 14, 1:30 am'
    )
    expect(umpireDate('2027-03-14T10:30:00Z', 'America/Los_Angeles')).equals(
      'Mar 14, 3:30 am'
    )
    expect(
      umpireTimeMatches('2027-03-14T10:30:00Z', 'America/Los_Angeles', {
        days: [6],
        from: '03:00',
        to: '04:00'
      })
    ).equals(true)
  })
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
    expect(body.games[0].choices['uty_plate:1'][0].reason).equals(null)
    expect(body.games[0].choices['uty_plate:1'][1].reason).equals(
      'already playing then'
    )
    expect(body.creditTeams.map((t: any) => t.id)).includes(f.teamA)
    expect((await get('view=league', 102)).status).equals(403)
    expect((await get('view=wrong')).status).equals(400)
    expect((await get('from=18:00&to=17:00')).status).equals(400)
    expect((await (await get('days=0')).json()).games).length(0)
    expect((await (await get('levels=missing')).json()).games).length(0)
    expect((await (await get('levels=ulv_majors')).json()).games).length(1)
  })
  it('uses the viewer timezone for row and conflict dates and day/time filters', async () => {
    await f.h.db
      .updateTable('games')
      .set({ timezone: 'UTC' })
      .where('id', '=', 'gam_umpire')
      .execute()
    try {
      const local = await get(
        'timezone=America%2FLos_Angeles&days=4&from=17:00&to=18:00'
      )
      expect(local.status).equals(200)
      const body = await local.json()
      expect(body.games).length(1)
      expect(body.games[0].date).equals('Apr 2, 5:00 pm')
      expect(body.games[0].conflicts[0].time).equals('Apr 2, 5:00 pm')
      expect(
        (await (await get('days=4&from=17:00&to=18:00')).json()).games
      ).length(0)
      expect((await (await get()).json()).games[0].date).equals(
        'Apr 3, 12:00 am'
      )
      expect((await get('timezone=Invalid')).status).equals(400)
    } finally {
      await f.h.db
        .updateTable('games')
        .set({ timezone: 'America/Los_Angeles' })
        .where('id', '=', 'gam_umpire')
        .execute()
    }
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
        body.games[0].choices['uty_plate:1'].some(
          (p: any) => p.userId === child
        )
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
  it('names the registry field and the assigned umpire display name', async () => {
    expect(asUmpireSchedule(await (await get()).json()).games[0].field).equals(
      ''
    )
    await f.h.db
      .insertInto('venues')
      .values({
        id: 'ven_umpire_schedule',
        google_place_id: 'umpire-schedule-field',
        name: 'Demo Park',
        address: '1 Demo Way',
        latitude: 40.05,
        longitude: -75.18,
        timezone: 'America/Los_Angeles'
      })
      .execute()
    await f.h.db
      .insertInto('venue_fields')
      .values({
        id: 'fld_umpire_schedule',
        venue_id: 'ven_umpire_schedule',
        name: 'North Diamond',
        sizes: ['50/70']
      })
      .execute()
    const userId = userIdOfGumbo(101)
    await f.h.db
      .updateTable('games')
      .set({ field_id: 'fld_umpire_schedule', field_size: '50/70' })
      .where('id', '=', 'gam_umpire')
      .execute()
    await f.h.db
      .insertInto('umpire_assignments')
      .values({
        game_id: 'gam_umpire',
        slot: 'uty_plate:1',
        user_id: userId,
        assigned_by: userId
      })
      .execute()
    try {
      const body = asUmpireSchedule(await (await get()).json())
      expect(body.games[0].venue).equals('Demo Field')
      expect(body.games[0].field).equals('North Diamond')
      const user = await f.h.db
        .selectFrom('users')
        .select('display_name')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
      expect(body.games[0].assignments['uty_plate:1'].displayName).equals(
        user.display_name
      )
      await f.h.db
        .updateTable('venue_fields')
        .set({ deleted_at: new Date() })
        .where('id', '=', 'fld_umpire_schedule')
        .execute()
      expect(
        asUmpireSchedule(await (await get()).json()).games[0].field
      ).equals('North Diamond')
    } finally {
      await f.h.db
        .deleteFrom('umpire_assignments')
        .where('game_id', '=', 'gam_umpire')
        .execute()
      await f.h.db
        .updateTable('games')
        .set({ field_id: null, field_size: null })
        .where('id', '=', 'gam_umpire')
        .execute()
      await f.h.db
        .deleteFrom('venue_fields')
        .where('id', '=', 'fld_umpire_schedule')
        .execute()
      await f.h.db
        .deleteFrom('venues')
        .where('id', '=', 'ven_umpire_schedule')
        .execute()
    }
  })
  it('omits zero needs, cancelled and withdrawn games, and keeps admin-only full visibility', async () => {
    await seedUmpireCounts(f.h.db, f.seasonA, false, 0)
    expect((await (await get()).json()).games).length(0)
    await seedUmpireCounts(f.h.db, f.seasonA, true, 1)
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
            slot: 'uty_plate:1',
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
        expect(game.assignments['uty_plate:1']?.assignedBy).equals(
          userIdOfGumbo(106)
        )
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

describe('an umpire column', () => {
  const positions = (slot: string, required: boolean): any => ({
    positions: [
      { slot, typeId: 'uty_field', typeName: 'Field', ordinal: 2, required }
    ]
  })
  it('says how many of the games offering it leave it optional', () => {
    const slot = 'uty_field:2'
    expect(optionalPositionHeader([positions(slot, true)], slot)).equals(
      undefined
    )
    expect(optionalPositionHeader([positions(slot, false)], slot)).equals(
      'Optional'
    )
    expect(
      optionalPositionHeader(
        [positions(slot, true), positions(slot, false)],
        slot
      )
    ).equals('Optional in some games')
    expect(optionalPositionHeader([], slot)).equals(undefined)
  })
  it('runs by the type order given, then by ordinal, once a slot', () => {
    const position = (typeId: string, ordinal: number): any => ({
      slot: `${typeId}:${ordinal}`,
      typeId,
      typeName: typeId,
      ordinal,
      required: true
    })
    const games = [
      { positions: [position('uty_field', 2), position('uty_plate', 1)] },
      { positions: [position('uty_field', 1), position('uty_field', 2)] }
    ]
    expect(
      umpireColumns([{ id: 'uty_plate' }, { id: 'uty_field' }], games).map(
        column => column.slot
      )
    ).deep.equals(['uty_plate:1', 'uty_field:1', 'uty_field:2'])
    expect(umpireColumns([{ id: 'uty_other' }], games)).deep.equals([])
  })
})

interface UmpirePage {
  items: UmpireGameRow[]
  nextCursor: string | null
  prevCursor: string | null
  anchorId: string | null
  counts: null
  positions: UmpireColumn[]
  games?: unknown
}

describe('umpire schedule pages (U9)', function () {
  this.timeout(60000)
  const DAY = 24 * 60 * 60 * 1000
  const NOW = Date.parse(UMPIRE_TEST_NOW)
  const mixed = 'sea_umpire_pages_mixed'
  let f: GroupFixture
  let old: string | undefined
  let tied: string[]
  const base = (): string =>
    `/leagues/${f.leagueA}/umpire-schedule?view=schedule`
  const read = async (query = '', status = 200): Promise<any> => {
    const response = await f.h.request(
      'GET',
      `${base()}${query}`,
      undefined,
      101
    )
    expect(response.status, query).equals(status)
    return await response.json()
  }
  const withCursor = (cursor: string): string =>
    `&cursor=${encodeURIComponent(cursor)}`
  const ids = (rows: Array<{ id: string }>): string[] => rows.map(row => row.id)
  const inOrder = (rows: UmpireGameRow[]): UmpireGameRow[] =>
    rows.toSorted((a, b) => {
      const date = Date.parse(a.startAt) - Date.parse(b.startAt)
      return date !== 0 ? date : a.id < b.id ? -1 : 1
    })
  const walk = async (query: string): Promise<UmpirePage[]> => {
    const pages: UmpirePage[] = [await read(query)]
    while (pages.at(-1)?.nextCursor != null) {
      pages.push(await read(query + withCursor(pages.at(-1)?.nextCursor ?? '')))
      expect(pages.length, 'a walk ends').lessThan(100)
    }
    return pages
  }

  before(async () => {
    old = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    // A season where the second field position is required, and another
    // where it is optional and only the third, which only this one has, is.
    await f.h.db
      .insertInto('seasons')
      .values({
        id: mixed,
        league_id: f.leagueA,
        name: 'Demo Mixed',
        year: 2027,
        starts_on: '2027-03-01',
        ends_on: '2027-05-31',
        timezone: 'UTC'
      })
      .execute()
    for (const season of [mixed, f.playoffs])
      await f.h.db
        .insertInto('season_umpire_requirements')
        .values({ season_id: season, level_id: 'ulv_majors' })
        .execute()
    await seedUmpireCounts(f.h.db, mixed, true, 2, 1)
    await seedUmpireCounts(f.h.db, f.playoffs, true, 1, 1)
    const game = (
      offset: number,
      fields: Record<string, unknown> = {}
    ): any => ({
      id: `gam_pages_${String(offset / DAY)
        .replace('-', 'm')
        .replace('.', '_')}`,
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      season_id: f.seasonA,
      start_at: new Date(NOW + offset),
      status: offset < 0 ? 'final' : 'scheduled',
      ...fields
    })
    const rows = Array.from({ length: 12 }, (_, index) =>
      game((index - 6) * DAY + DAY / 4)
    )
    const ties = ['A', 'b', 'C', 'd'].map(letter =>
      game(-DAY, { id: `gam_pages_tied_${letter}`, status: 'final' })
    )
    tied = ties.map(row => row.id)
    await f.h.db
      .insertInto('games')
      .values([
        ...rows,
        ...ties,
        game(1.5 * DAY, { season_id: f.playoffs }),
        // On a Saturday, as nothing else is.
        game(16.25 * DAY, { id: 'gam_pages_mixed', season_id: mixed })
      ])
      .execute()
  })
  after(async () => {
    if (old == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = old
    await f?.h.close()
  })

  it('walks to the rows of the unpaged schedule, with no others', async () => {
    const whole: { games: UmpireGameRow[] } = await read()
    expect(whole.games.length).greaterThan(15)
    const pages = await walk('&paged=1&limit=4')
    expect(pages.flatMap(page => ids(page.items))).deep.equals(
      ids(inOrder(whole.games))
    )
    for (const page of pages) expect(page.items.length).most(4)
    expect(pages[0].prevCursor).equals(null)
    // A row of a page is the row the whole schedule has.
    expect(pages[1].items[0]).deep.equals(
      whole.games.find(row => row.id === pages[1].items[0].id)
    )
  })

  it('holds rows of one instant across a page break', async () => {
    const pages = await walk('&paged=1&limit=1')
    expect(
      pages.flatMap(page => ids(page.items)).filter(id => tied.includes(id))
    ).deep.equals(tied.toSorted())
  })

  it('walks back to the same rows', async () => {
    const first: UmpirePage = await read('&paged=1&limit=5')
    const second: UmpirePage = await read(
      `&paged=1&limit=5${withCursor(first.nextCursor ?? '')}`
    )
    const back: UmpirePage = await read(
      `&paged=1&limit=5${withCursor(second.prevCursor ?? '')}`
    )
    expect(ids(back.items)).deep.equals(ids(first.items))
    expect(back.prevCursor).equals(null)
  })

  it("gives every page the whole filtered list's columns", async () => {
    const whole: { games: UmpireGameRow[]; types: Array<{ id: string }> } =
      await read()
    const want = umpireColumns(whole.types, whole.games)
    expect(
      want.map(column => [column.slot, column.optionalHeader])
    ).deep.equals([
      ['uty_plate:1', null],
      ['uty_field:1', null],
      ['uty_field:2', 'Optional in some games'],
      ['uty_field:3', 'Optional']
    ])
    const pages = await walk('&paged=1&limit=3')
    // The first page's rows offer two columns of the four.
    expect(
      new Set(pages[0].items.flatMap(row => row.positions.map(p => p.slot)))
        .size
    ).equals(2)
    for (const page of pages) expect(page.positions).deep.equals(want)
  })

  it('narrows the columns with the filter', async () => {
    // Monday is day 0, and 2027-04-17, the mixed game's date, is a Saturday.
    const saturday: UmpirePage = await read('&paged=1&days=5')
    expect(ids(saturday.items)).includes('gam_pages_mixed')
    expect(saturday.positions.map(column => column.slot)).includes(
      'uty_field:3'
    )
    const wednesday: UmpirePage = await read('&paged=1&days=2')
    expect(
      wednesday.positions.map(column => [column.slot, column.optionalHeader])
    ).deep.equals(
      umpireColumns(
        [{ id: 'uty_plate' }, { id: 'uty_field' }],
        (await read('&days=2')).games
      ).map(column => [column.slot, column.optionalHeader])
    )
  })

  it('opens on the rule, with rows before it, and meets every row', async () => {
    const whole: { games: UmpireGameRow[] } = await read()
    const list = inOrder(whole.games)
    const rule = initialUmpireGame(list, NOW)
    const page: UmpirePage = await read('&paged=1&limit=4&around=next')
    expect(page.anchorId).equals(rule?.id)
    const at = list.findIndex(row => row.id === rule?.id)
    expect(at).greaterThan(2)
    expect(ids(page.items)).deep.equals(ids(list.slice(at - 2, at + 4)))
    const back: UmpirePage[] = []
    let older = page
    while (older.prevCursor != null) {
      older = await read(`&paged=1&limit=4${withCursor(older.prevCursor)}`)
      back.unshift(older)
    }
    const after: UmpirePage[] = []
    let newer = page
    while (newer.nextCursor != null) {
      newer = await read(`&paged=1&limit=4${withCursor(newer.nextCursor)}`)
      after.push(newer)
    }
    expect(
      [...back, page, ...after].flatMap(one => ids(one.items))
    ).deep.equals(ids(list))
  })

  it('opens a schedule past its last game on the last one', async () => {
    const answer = await umpireSchedulePage(
      f.h.db,
      actor(101),
      f.leagueA,
      'schedule',
      { days: [5] },
      { around: true, limit: 2 }
    )
    expect(answer.anchorId).not.equals(null)
    const held = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = '2027-05-20T12:00:00Z'
    const late: UmpirePage = await read('&paged=1&limit=2&around=next')
    process.env.TS_UMPIRE_NOW = held
    expect(late.anchorId).equals('gam_pages_mixed')
    expect(late.nextCursor).equals(null)
  })

  it('answers no rows with an empty page and no anchor', async () => {
    const empty: UmpirePage = await read('&paged=1&around=next&levels=missing')
    expect(empty).deep.include({
      items: [],
      nextCursor: null,
      prevCursor: null,
      anchorId: null,
      counts: null,
      positions: []
    })
  })

  it('leaves the unpaged answer as it was', async () => {
    const whole = await read()
    expect(Object.keys(whole).toSorted()).deep.equals(
      [
        'creditTeams',
        'games',
        'isAdmin',
        'levels',
        'noteTypes',
        'settings',
        'types',
        'view',
        'viewerId'
      ].toSorted()
    )
    // The route names its people to its reader.
    expect(
      await schedule(
        f.h.db,
        actor(101),
        f.leagueA,
        'schedule',
        {},
        readerOf(actor(101))
      )
    ).deep.equals(whole)
    const page: UmpirePage = await read('&paged=1')
    expect(page.games).equals(undefined)
    expect(page).deep.include({
      viewerId: whole.viewerId,
      isAdmin: whole.isAdmin,
      view: 'schedule'
    })
  })

  it('leaves view=league unpaged, and reads the umpire view by page', async () => {
    const path = `/leagues/${f.leagueA}/umpire-schedule`
    const league = await f.h.request(
      'GET',
      `${path}?view=league&paged=1`,
      undefined,
      101
    )
    expect(league.status).equals(400)
    expect(((await league.json()) as { message: string }).message).equals(
      'paged does not apply with view=league'
    )
    const whole = await f.h.request(
      'GET',
      `${path}?view=league`,
      undefined,
      101
    )
    expect(((await whole.json()) as { games: unknown[] }).games.length).above(0)
    const own = await f.h.request('GET', `${path}?paged=1`, undefined, 101)
    expect(own.status).equals(200)
    expect(((await own.json()) as { view: string }).view).equals('umpire')
  })

  it('answers a page as large as the rows a table holds, up to 500', async () => {
    // Each page computes the whole schedule, so a table reads what it holds
    // again in one read.
    const whole: UmpirePage = await read('&paged=1&limit=500')
    const paged: UmpirePage = await read('&paged=1&limit=1')
    expect(whole.items.length).above(paged.items.length)
    expect(whole.nextCursor).equals(null)
  })

  it('refuses what a page cannot be, naming the parameter', async () => {
    const says = async (query: string): Promise<string> =>
      (await read(query, 400)).message
    expect(await says('&cursor=abc')).equals('cursor needs paged')
    expect(await says('&around=next')).equals('around needs paged')
    expect(await says('&paged=2')).equals('paged must be 1 or true')
    expect(await says('&paged=1&cursor=abc')).equals(
      'cursor is not a cursor this list gave'
    )
    expect(await says('&paged=1&limit=501')).equals(
      'limit must be at most 500 with paged'
    )
    expect(await says('&paged=1&around=soon')).equals('around must be next')
    const first: UmpirePage = await read('&paged=1&limit=1')
    expect(
      await says(`&paged=1&around=next${withCursor(first.nextCursor ?? '')}`)
    ).equals('around does not apply with cursor')
  })

  it('reads through the client, its filters as the whole list takes them', async () => {
    const client = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
    const page = await client.umpireSchedulePage(
      f.leagueA,
      'view=schedule&days=0,5',
      { around: 'next', limit: 3 }
    )
    expect(page.anchorId).not.equals(null)
    expect(page.items.length).above(0)
    expect(page.positions.length).above(1)
    const on = await client.umpireSchedulePage(
      f.leagueA,
      'view=schedule&days=0,5',
      { cursor: page.nextCursor ?? '' }
    )
    expect(on.prevCursor).not.equals(null)
  })
})

describe('umpire schedule acceptance', function () {
  this.timeout(60000)
  let f: GroupFixture
  let old: string | undefined
  let next = 300
  const games = async (user: number): Promise<string[]> => {
    const response = await f.h.request(
      'GET',
      `/leagues/${f.leagueA}/umpire-schedule?view=umpire`,
      undefined,
      user
    )
    expect(response.status).equals(200)
    return (await response.json()).games.map((g: any) => g.id)
  }
  const signUp = async (
    user: number,
    userId: string,
    game = 'gam_umpire_other'
  ): Promise<Response> =>
    await f.h.request(
      'POST',
      `/games/${game}/umpire-slots`,
      { slot: 'uty_plate:1', userId },
      user
    )
  const fresh = async (role = true): Promise<[number, string]> => {
    const id = next++
    return [id, await freshUmpire(f, id, role)]
  }
  before(async () => {
    old = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    await addAcceptanceSeasons(f)
  })
  afterEach(async () => {
    await f.h.db
      .deleteFrom('umpire_assignments')
      .where('game_id', 'in', ['gam_umpire', 'gam_umpire_other'])
      .execute()
  })
  after(async () => {
    await f?.h.close()
    if (old == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = old
  })
  const all = ['gam_umpire', 'gam_umpire_other', 'gam_umpire_past']

  it('lists every league game for a league member, who signs up in a season no family plays in', async () => {
    const [id, userId] = await fresh()
    await f.h.db
      .insertInto('league_members')
      .values({
        id: `lmb_acceptance_${id}`,
        league_id: f.leagueA,
        user_id: userId,
        role: 'member'
      })
      .execute()
    expect(await games(id)).members(all)
    expect((await signUp(id, userId)).status).equals(200)
  })
  for (const [label, scope, role] of [
    ['a league administrator role', 'league', 'admin'],
    ['a direct league role', 'league', 'coach'],
    ['a direct role on one season', 'season', 'coach'],
    ['a coach role on a team active in one season', 'team', 'coach']
  ] as const)
    it(`lists every league game for ${label}`, async () => {
      const [id, userId] = await fresh()
      await grantScopeRole(
        f,
        userId,
        scope,
        scope === 'league'
          ? f.leagueA
          : scope === 'season'
            ? f.seasonA
            : f.teamA,
        role
      )
      expect(await games(id)).members(all)
      expect((await signUp(id, userId)).status).equals(200)
    })
  it('lists every league game for a season member of one season', async () => {
    const [id, userId] = await fresh()
    await f.h.db
      .insertInto('season_members')
      .values({
        id: `smb_acceptance_${id}`,
        season_id: f.seasonA,
        user_id: userId,
        role: 'member'
      })
      .execute()
    expect(await games(id)).members(all)
    expect((await signUp(id, userId)).status).equals(200)
  })
  for (const role of ['member', 'owner', 'manager'] as const)
    it(`lists every league game for a non-player ${role} of a team, who is never playing`, async () => {
      const [id, userId] = await fresh()
      await f.h.db
        .insertInto('memberships')
        .values({
          id: `mem_acceptance_${id}`,
          team_id: f.teamA,
          user_id: userId,
          is_player: false,
          role
        })
        .execute()
      expect(await games(id)).members(all)
      const body = await (
        await f.h.request(
          'GET',
          `/leagues/${f.leagueA}/umpire-schedule?view=umpire`,
          undefined,
          id
        )
      ).json()
      const own = body.games.find((g: any) => g.id === 'gam_umpire')
      expect(
        own.conflicts.filter(
          (c: any) => c.userId === userId && c.activity === 'playing'
        )
      ).length(0)
      expect(
        own.choices['uty_plate:1'].find((c: any) => c.userId === userId).reason
      ).equals(null)
      expect((await signUp(id, userId, 'gam_umpire')).status).equals(200)
    })
  it('keeps a team coach off "already playing" on their own team\'s game', async () => {
    const [id, userId] = await fresh()
    await grantScopeRole(f, userId, 'team', f.teamA)
    const body = await (
      await f.h.request(
        'GET',
        `/leagues/${f.leagueA}/umpire-schedule?view=umpire`,
        undefined,
        id
      )
    ).json()
    const own = body.games.find((g: any) => g.id === 'gam_umpire')
    expect(own.conflicts.some((c: any) => c.userId === userId)).equals(false)
    expect(
      own.choices['uty_plate:1'].find((c: any) => c.userId === userId).reason
    ).equals(null)
  })
  it('lists every league game for the guardian of a player on a league team', async () => {
    const [id, userId] = await fresh()
    const [, child] = await fresh(false)
    await f.h.db
      .insertInto('user_links')
      .values({
        id: `lnk_acceptance_${id}`,
        user_id: userId,
        related_user_id: child,
        kind: 'guardian'
      })
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: `mem_acceptance_child_${id}`,
        team_id: f.teamA,
        user_id: child,
        is_player: true,
        role: 'member'
      })
      .execute()
    expect(await games(id)).members(all)
  })
  it('lists nothing for the guardian of a disabled player only', async () => {
    const [id, userId] = await fresh()
    const [, child] = await fresh(false)
    await f.h.db
      .insertInto('user_links')
      .values({
        id: `lnk_acceptance_${id}`,
        user_id: userId,
        related_user_id: child,
        kind: 'guardian'
      })
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: `mem_acceptance_child_${id}`,
        team_id: f.teamA,
        user_id: child,
        is_player: true,
        role: 'member'
      })
      .execute()
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', child)
      .execute()
    expect(await games(id)).length(0)
  })
  it('lists nothing for the coach of a team inactive in its only league season', async () => {
    const [id, userId] = await fresh()
    const team = 'tem_acceptance_inactive'
    await f.h.db
      .insertInto('teams')
      .values({ id: team, name: 'Demo Withdrawn' })
      .execute()
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonA, team_id: team, active: false })
      .execute()
    await grantScopeRole(f, userId, 'team', team)
    expect(await games(id)).length(0)
  })
  it('lists nothing for a follower, who cannot sign up', async () => {
    const [id, userId] = await fresh()
    await f.h.db
      .insertInto('team_follows')
      .values({ user_id: userId, team_id: f.teamA })
      .execute()
    expect(await games(id)).length(0)
    const refused = await signUp(id, userId, 'gam_umpire')
    expect(refused.status).equals(403)
    expect((await refused.json()).message).equals(
      'This game is outside your umpire schedule'
    )
  })
  it('lists nothing for someone accepted only in another league', async () => {
    const [id, userId] = await fresh()
    await f.h.db
      .insertInto('league_members')
      .values({
        id: `lmb_acceptance_${id}`,
        league_id: f.leagueB,
        user_id: userId,
        role: 'member'
      })
      .execute()
    expect(await games(id)).length(0)
  })
  it('refuses the umpire view to someone accepted without the umpire role', async () => {
    const [id, userId] = await fresh(false)
    await f.h.db
      .insertInto('league_members')
      .values({
        id: `lmb_acceptance_${id}`,
        league_id: f.leagueA,
        user_id: userId,
        role: 'member'
      })
      .execute()
    const response = await f.h.request(
      'GET',
      `/leagues/${f.leagueA}/umpire-schedule?view=umpire`,
      undefined,
      id
    )
    expect(response.status).equals(403)
    expect((await response.json()).message).equals(
      'Not an umpire for this league'
    )
  })
  it('lists a past game of another season for the accepted only', async () => {
    const [accepted, acceptedId] = await fresh()
    await f.h.db
      .insertInto('season_members')
      .values({
        id: `smb_acceptance_${accepted}`,
        season_id: f.seasonA,
        user_id: acceptedId,
        role: 'member'
      })
      .execute()
    const [outsider] = await fresh()
    expect(await games(accepted)).includes('gam_umpire_past')
    expect(await games(outsider)).not.includes('gam_umpire_past')
  })
  it('takes the games away once someone leaves the league', async () => {
    for (const add of [
      async (userId: string, id: number) => {
        await f.h.db
          .insertInto('league_members')
          .values({
            id: `lmb_acceptance_${id}`,
            league_id: f.leagueA,
            user_id: userId,
            role: 'member'
          })
          .execute()
        return async () => {
          await f.h.db
            .deleteFrom('league_members')
            .where('id', '=', `lmb_acceptance_${id}`)
            .execute()
        }
      },
      async (userId: string) => {
        const role = await grantScopeRole(f, userId, 'season', f.seasonA)
        return async () => {
          await f.h.db
            .deleteFrom('scope_roles')
            .where('id', '=', role)
            .execute()
        }
      },
      async (userId: string, id: number) => {
        await f.h.db
          .insertInto('memberships')
          .values({
            id: `mem_acceptance_${id}`,
            team_id: f.teamA,
            user_id: userId,
            is_player: false,
            role: 'member'
          })
          .execute()
        return async () => {
          await f.h.db
            .deleteFrom('memberships')
            .where('id', '=', `mem_acceptance_${id}`)
            .execute()
        }
      }
    ]) {
      const [id, userId] = await fresh()
      const remove = await add(userId, id)
      expect(await games(id)).members(all)
      await remove()
      expect(await games(id)).length(0)
    }
  })
})
