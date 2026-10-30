import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { initialUmpireGame } from '../../common/nextGame'
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
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { seedUmpireCounts } from '../../test/umpireTypes'
import { now } from '../clock'
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
    expect(
      await schedule(f.h.db, actor(101), f.leagueA, 'schedule', {})
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

  it('refuses what a page cannot be, naming the parameter', async () => {
    const says = async (query: string): Promise<string> =>
      (await read(query, 400)).message
    expect(await says('&cursor=abc')).equals('cursor needs paged')
    expect(await says('&around=next')).equals('around needs paged')
    expect(await says('&paged=2')).equals('paged must be 1 or true')
    expect(await says('&paged=1&cursor=abc')).equals(
      'cursor is not a cursor this list gave'
    )
    expect(await says('&paged=1&limit=101')).includes('limit')
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
