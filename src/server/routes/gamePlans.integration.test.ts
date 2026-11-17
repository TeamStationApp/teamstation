import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Client } from 'pg'

import {
  asGamePlansResponse,
  asSidePlan,
  type GamePlansResponse,
  type SidePlan
} from '../../common/api'
import {
  type GamePlan,
  type PlanCell,
  planHasPositions
} from '../../common/gamePlan'
import { makeId } from '../../common/ids'
import { EMPTY_PLAN_SAME_DAY } from '../../common/planWarnings'
import {
  DEFAULT_PLAYING_TIME_RULES,
  type PlayingTimeRules
} from '../../common/playingTimeRules'
import { userIdOfGumbo } from '../../common/userId'
import { testDatabaseUrlOf } from '../../migrate/testDatabase'
import { type ApiFixture, apiFixture } from '../../test/apiFixture'
import { planTeams } from '../access'
import {
  asGameChangePayload,
  GAME_CHANGES_CHANNEL
} from '../socket/gameChanges'

const rules = (changes: Partial<PlayingTimeRules>): PlayingTimeRules => ({
  ...DEFAULT_PLAYING_TIME_RULES,
  ...changes
})

/** Ichiro, the coach of Demo Hawks (`guardianFixture`), who reads and saves its plan. */
const TEAM_COACH = 104

/** Demo Hawks' players, and one made up at the field. */
const SORIANO = { gumboId: 201, fullName: 'Alfonso Soriano', jersey: '7' }
const CHAPMAN = { gumboId: 202, fullName: 'Ben Chapman', jersey: '12' }
const DECKER = { gumboId: 203, fullName: 'Cody Decker', jersey: '23' }
const BERRA = { gumboId: null, fullName: 'Yogi Berra', jersey: '8' }

/**
 * A plan of these rows, each a string of cells such as `'SS 2B _ _'`, where
 * `_` is a blank (the bench), on when it holds a position, as the server
 * stores it.
 */
const planOf = (
  rows: Array<[typeof SORIANO | typeof BERRA, string]>
): GamePlan => {
  const cells = rows.map(([, text]) =>
    text.split(' ').map(cell => (cell === '_' ? '' : cell) as PlanCell)
  )
  const plan = {
    innings: cells[0]?.length ?? 6,
    rows: rows.map(([player], at) => ({ player, cells: cells[at] }))
  }
  return { enabled: planHasPositions(plan), ...plan }
}

describe('game plans (GET and PUT /games/:gameId/plans)', function () {
  this.timeout(60000)
  let f: ApiFixture
  let listener: Client
  let heard: Array<Record<string, unknown>> = []
  /** Demo Hawks at home to Demo Visitors, in Demo Regular. */
  let game: string

  const get = async (
    gameId: string,
    userId: number
  ): Promise<{ status: number; body: unknown }> => {
    const answer = await f.h.request(
      'GET',
      `/games/${gameId}/plans`,
      undefined,
      userId
    )
    return { status: answer.status, body: await answer.json() }
  }
  const plans = async (
    gameId: string,
    userId = TEAM_COACH
  ): Promise<GamePlansResponse> => {
    const answer = await get(gameId, userId)
    expect(answer.status).equals(200)
    return asGamePlansResponse(answer.body)
  }
  const put = async (
    gameId: string,
    teamId: string,
    body: unknown,
    userId = TEAM_COACH
  ): Promise<{ status: number; body: unknown }> => {
    const answer = await f.h.request(
      'PUT',
      `/games/${gameId}/plans/${teamId}`,
      body,
      userId
    )
    return { status: answer.status, body: await answer.json() }
  }
  const saved = async (
    gameId: string,
    plan: GamePlan,
    userId = TEAM_COACH
  ): Promise<SidePlan> => {
    const answer = await put(gameId, f.teamA, plan, userId)
    expect(answer.status, JSON.stringify(answer.body)).equals(200)
    return asSidePlan(answer.body)
  }
  const newGame = async (
    startAt: string,
    changes: {
      seasonId?: string | null
      status?: 'scheduled' | 'final' | 'cancelled'
    } = {}
  ): Promise<string> => {
    const id = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: f.teamA,
        away_team_id: f.standaloneTeam,
        season_id:
          changes.seasonId === undefined ? f.seasonA : changes.seasonId,
        start_at: new Date(startAt),
        status: changes.status ?? 'scheduled',
        timezone: 'America/Los_Angeles'
      })
      .execute()
    return id
  }
  /**
   * Waits for a notify sent after everything already committed, which
   * Postgres delivers in commit order, and forgets all heard before it.
   */
  const forgetHeard = async (): Promise<void> => {
    const mark = makeId('game')
    await sql`select pg_notify(${GAME_CHANGES_CHANNEL}, ${JSON.stringify({ mark })})`.execute(
      f.h.db
    )
    while (!heard.some(payload => payload.mark === mark))
      await new Promise(resolve => setTimeout(resolve, 5))
    heard = []
  }
  const setRules = async (
    table: 'seasons' | 'teams',
    id: string,
    value: PlayingTimeRules | null
  ): Promise<void> => {
    await f.h.db
      .updateTable(table)
      .set({
        playing_time_rules: value == null ? null : JSON.stringify(value)
      })
      .where('id', '=', id)
      .execute()
  }

  before(async function () {
    f = await apiFixture()
    // Saturday 10 April 2027, 10:00 in Los Angeles.
    game = await newGame('2027-04-10T17:00:00Z')
    const { rows } = await sql<{
      name: string
    }>`select current_database() as name`.execute(f.h.db)
    listener = new Client({ connectionString: testDatabaseUrlOf(rows[0].name) })
    await listener.connect()
    listener.on('notification', message => {
      if (message.payload != null)
        heard.push(JSON.parse(message.payload) as Record<string, unknown>)
    })
    await listener.query(`listen ${GAME_CHANGES_CHANNEL}`)
  })
  after(async function () {
    await listener?.end()
    await f?.h.close()
  })
  beforeEach(async function () {
    await f.h.db.deleteFrom('game_plans').execute()
    for (const table of ['seasons', 'teams'] as const)
      await f.h.db
        .updateTable(table)
        .set({ playing_time_rules: null })
        .execute()
  })

  it('lets the head coach save and read his side, and nobody else’s', async function () {
    const plan = planOf([
      [SORIANO, 'SS SS 2B 2B _ _'],
      [BERRA, 'C C _ _ LF LF']
    ])
    const side = await saved(game, plan, f.people.teamCoach)
    expect(side).deep.equals({
      teamId: f.teamA,
      plan,
      rules: null,
      sameDay: EMPTY_PLAN_SAME_DAY
    })
    const stored = await f.h.db
      .selectFrom('game_plans')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(stored).to.include({
      game_id: game,
      team_id: f.teamA,
      enabled: true,
      innings: 6
    })
    expect(stored.rows).deep.equals(plan.rows)
    const read = await plans(game, f.people.teamCoach)
    expect(read).deep.equals({ away: null, home: side })
    // Saved again, it replaces the first.
    const blank = planOf([[SORIANO, '_ _ _ _ _ _']])
    expect((await saved(game, blank, f.people.teamCoach)).plan).deep.equals(
      blank
    )
    expect(
      (await f.h.db.selectFrom('game_plans').selectAll().execute()).length
    ).equals(1)
    // Before a save, a side he may plan answers no plan.
    expect((await plans(f.games[1].id, f.people.teamCoach)).away).to.include({
      teamId: f.teamA,
      plan: null
    })
  })

  it('answers the plan to the team’s coaches and assistants alone: no scorekeeper or admin of any level, until an admin is given the coach or the assistant flag', async function () {
    const plan = planOf([[SORIANO, 'SS']])
    await saved(game, plan)
    // The team's coach, a coach given the flag on its season, and the team's
    // assistant.
    for (const id of [
      f.people.teamCoach,
      f.people.seasonCoach,
      f.people.assistant
    ]) {
      const read = await plans(game, id)
      expect(read.home?.plan, String(id)).deep.equals(plan)
      expect(read.away, String(id)).equals(null)
    }
    for (const id of [f.people.seasonCoach, f.people.assistant])
      expect((await put(game, f.teamA, plan, id)).status, String(id)).equals(
        200
      )
    // Nobody else, whatever else they may do with the team.
    for (const id of [
      f.people.scorekeeper,
      f.people.admin,
      f.people.siteAdmin
    ]) {
      expect(await plans(game, id), String(id)).deep.equals({
        away: null,
        home: null
      })
      const refused = await put(game, f.teamA, plan, id)
      expect(refused.status, String(id)).equals(403)
      expect((refused.body as { message?: string }).message).equals(
        "Only the team's coaches and assistants may save its game plan"
      )
      expect(
        (await put(game, f.standaloneTeam, plan, id)).status,
        String(id)
      ).equals(403)
    }
    // The league, season and team admin, given the coach or the assistant
    // flag on the team, reads and saves it.
    for (const flag of ['coach', 'assistant'] as const) {
      const role = makeId('scopeRole')
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: role,
          user_id: userIdOfGumbo(f.people.admin),
          scope_type: 'team',
          scope_id: f.teamA,
          role: flag
        })
        .execute()
      try {
        expect(
          (await plans(game, f.people.admin)).home?.plan,
          flag
        ).deep.equals(plan)
        expect(
          (await put(game, f.teamA, plan, f.people.admin)).status,
          flag
        ).equals(200)
      } finally {
        await f.h.db.deleteFrom('scope_roles').where('id', '=', role).execute()
      }
    }
  })

  it('refuses a member who may not save the lineup, and answers him no side', async function () {
    const refused = await put(
      game,
      f.teamA,
      planOf([[SORIANO, 'SS']]),
      f.people.guardian
    )
    expect(refused.status).equals(403)
    expect(await plans(game, f.people.guardian)).deep.equals({
      away: null,
      home: null
    })
    expect(
      await f.h.db.selectFrom('game_plans').selectAll().execute()
    ).deep.equals([])
  })

  it('stores a plan on only when it holds a position, whatever the save says, and reads a dash as the bench', async function () {
    const sent = (cells: string[], enabled: boolean): unknown => ({
      enabled,
      innings: cells.length,
      rows: [{ player: SORIANO, cells }]
    })
    const stored = async (): Promise<boolean> =>
      (
        await f.h.db
          .selectFrom('game_plans')
          .select('enabled')
          .executeTakeFirstOrThrow()
      ).enabled
    // A plan of no positions is off, though it was sent on.
    let side = await saved(game, sent(['', 'DH', 'EH'], true) as GamePlan)
    expect(side.plan?.enabled).equals(false)
    expect(await stored()).equals(false)
    // One position turns it on, though it was sent off. A plan saved by an
    // older client sits with a dash, which is stored blank.
    side = await saved(game, sent(['-', 'SS', '-'], false) as GamePlan)
    expect(side.plan).deep.equals(planOf([[SORIANO, '_ SS _']]))
    expect(await stored()).equals(true)
    const row = await f.h.db
      .selectFrom('game_plans')
      .select('rows')
      .executeTakeFirstOrThrow()
    expect(row.rows).deep.equals([{ player: SORIANO, cells: ['', 'SS', ''] }])
    // A plan stored before it was derived, with a dash and its old toggle,
    // reads as it would be saved now.
    await f.h.db
      .updateTable('game_plans')
      .set({
        enabled: false,
        rows: JSON.stringify([{ player: SORIANO, cells: ['C', '-', '-'] }])
      })
      .execute()
    expect((await plans(game)).home?.plan).deep.equals(
      planOf([[SORIANO, 'C _ _']])
    )
  })

  it('refuses a cell that is no value, more than 12 innings, or a row of the wrong length', async function () {
    const good = planOf([[SORIANO, 'SS 2B']])
    for (const bad of [
      { ...good, rows: [{ player: SORIANO, cells: ['SS', 'X'] }] },
      { ...good, rows: [{ player: SORIANO, cells: ['SS', 'ss'] }] },
      { ...good, rows: [{ player: SORIANO, cells: ['SS', 'SSS'] }] },
      {
        enabled: false,
        innings: 13,
        rows: [{ player: SORIANO, cells: Array(13).fill('') }]
      },
      { ...good, innings: 0, rows: [] },
      { ...good, innings: 2.5 },
      { ...good, innings: 3 },
      { ...good, rows: [{ player: { ...SORIANO, gumboId: 0 }, cells: [] }] },
      { ...good, enabled: 'yes' },
      'not a plan'
    ]) {
      const answer = await put(game, f.teamA, bad)
      expect(answer.status, JSON.stringify(bad)).equals(400)
    }
    expect(
      (
        (await put(game, f.teamA, { ...good, innings: 3 })).body as {
          message: string
        }
      ).message
    ).match(/Row 1 has 2 cells for 3 innings/)
  })

  it('answers 404 for a game that is not there or not his to see, and a team not in it', async function () {
    const plan = planOf([[SORIANO, 'SS']])
    expect((await put('gam_nowhere', f.teamA, plan)).status).equals(404)
    expect((await get('gam_nowhere', 101)).status).equals(404)
    expect((await put(game, f.teamB, plan)).status).equals(404)
    // Demo Comets' game, which only Alfonso's side may open.
    expect((await get(f.cometsGame, f.people.teamCoach)).status).equals(404)
    expect(
      (await put(f.cometsGame, f.secondTeam, plan, f.people.teamCoach)).status
    ).equals(404)
  })

  it('answers no season history, whatever the team planned earlier in the season', async function () {
    const earlier = await newGame('2027-04-01T17:00:00Z')
    await saved(
      earlier,
      planOf([
        [SORIANO, 'SS SS LF _'],
        [BERRA, 'C _ _ RF']
      ])
    )
    const answer = await get(game, TEAM_COACH)
    expect(answer.status).equals(200)
    const { home } = answer.body as { home: Record<string, unknown> }
    expect(Object.keys(home)).deep.equals([
      'teamId',
      'plan',
      'rules',
      'sameDay'
    ])
    expect(home.sameDay).deep.equals(EMPTY_PLAN_SAME_DAY)
  })

  it('counts the team’s other games on the same date in the game’s time zone, split at this one', async function () {
    // 08:00 on the 10th in Los Angeles, before the game's 10:00.
    const morning = await newGame('2027-04-10T15:00:00Z')
    // 19:00 on the 10th in Los Angeles, though the 11th in UTC.
    const evening = await newGame('2027-04-11T02:00:00Z', { seasonId: null })
    // 01:00 on the 11th, and 23:00 on the 9th, in Los Angeles.
    const nextDay = await newGame('2027-04-11T08:00:00Z')
    const dayBefore = await newGame('2027-04-10T06:00:00Z')
    const cancelled = await newGame('2027-04-10T20:00:00Z', {
      status: 'cancelled'
    })
    // The morning's catching can block a pitch here; its pitching blocks
    // nothing.
    await saved(
      morning,
      planOf([
        [DECKER, 'C C C C P'],
        [CHAPMAN, 'P P C _ _'],
        [BERRA, 'P P P P P']
      ])
    )
    // The evening's pitching can be blocked by catching here; its catching
    // blocks nothing here.
    await saved(
      evening,
      planOf([
        [SORIANO, 'C C C C P'],
        [CHAPMAN, 'SS P SS SS SS'],
        [DECKER, 'SS SS SS SS SS']
      ])
    )
    for (const ignored of [nextDay, dayBefore, cancelled])
      await saved(ignored, planOf([[SORIANO, 'C C C C P']]))
    // The game's own plan is not another game's.
    await saved(game, planOf([[SORIANO, 'P C']]))
    const { home } = await plans(game)
    expect(home?.sameDay).deep.equals({
      before: { catcherInnings: { 'g:203': 4, 'g:202': 1 } },
      laterPitched: { 'g:201': true, 'g:202': true }
    })
    // From the evening, the morning and this game both come first.
    expect((await plans(evening)).home?.sameDay).deep.equals({
      before: { catcherInnings: { 'g:203': 4, 'g:202': 1, 'g:201': 1 } },
      laterPitched: {}
    })
  })

  it('puts a same-day game at the same start time before this one when its id sorts first', async function () {
    const tied = await newGame('2027-04-10T17:00:00Z')
    await saved(tied, planOf([[DECKER, 'C C C C P']]))
    await saved(game, planOf([[DECKER, 'P C C C C']]))
    const tiedFirst = tied < game
    const earlier = {
      before: { catcherInnings: { 'g:203': 4 } },
      laterPitched: {}
    }
    const later = {
      before: { catcherInnings: {} },
      laterPitched: { 'g:203': true }
    }
    expect((await plans(game)).home?.sameDay).deep.equals(
      tiedFirst ? earlier : later
    )
    expect((await plans(tied)).home?.sameDay).deep.equals(
      tiedFirst ? later : earlier
    )
  })

  it('counts a same-day game shortened before its plan ran out only through the innings it reached', async function () {
    // The first game of a doubleheader, called after three of five planned
    // innings: Decker caught three, not the fourth.
    const first = await newGame('2027-04-10T15:00:00Z', { status: 'final' })
    // The last, called after one: Chapman never reached his pitch.
    const last = await newGame('2027-04-11T01:00:00Z', { status: 'final' })
    const reached = async (gameId: string, count: number): Promise<void> => {
      const innings = Array.from({ length: count }, (_, at) => ({
        num: at + 1,
        ordinalNum: `${at + 1}`,
        home: { runs: 0 },
        away: { runs: 0 }
      }))
      await f.h.db
        .updateTable('games')
        .set({ linescore: JSON.stringify({ innings }) })
        .where('id', '=', gameId)
        .execute()
    }
    await reached(first, 3)
    await reached(last, 1)
    await saved(first, planOf([[DECKER, 'C C C C P']]))
    await saved(last, planOf([[CHAPMAN, 'SS P SS SS SS']]))
    const { home } = await plans(game)
    expect(home?.sameDay).deep.equals({
      before: { catcherInnings: { 'g:203': 3 } },
      laterPitched: {}
    })
  })

  it('judges by the team’s rules, then the game’s season’s, then the latest managing season’s, then none', async function () {
    const spring = rules({ defensivePlayingTime: true })
    const fall = rules({ continuousBatting: true })
    const own = rules({ enforceSittingLimits: true })
    // Demo Playoffs manages the Hawks too, and starts last.
    await f.h.db
      .insertInto('season_team_parents')
      .values({ season_id: f.playoffs, team_id: f.teamA })
      .onConflict(oc => oc.doNothing())
      .execute()
    await f.h.db
      .updateTable('seasons')
      .set({ starts_on: '2027-08-01', ends_on: '2027-10-31' })
      .where('id', '=', f.playoffs)
      .execute()
    const fallGame = await newGame('2027-09-04T17:00:00Z', {
      seasonId: f.playoffs
    })
    const rulesOf = async (gameId: string): Promise<unknown> =>
      (await plans(gameId)).home?.rules
    expect(await rulesOf(game)).equals(null)
    await setRules('seasons', f.playoffs, fall)
    // The spring season has none, so its game follows the managing season.
    expect(await rulesOf(game)).deep.equals(fall)
    await setRules('seasons', f.seasonA, spring)
    expect(await rulesOf(game)).deep.equals(spring)
    expect(await rulesOf(fallGame)).deep.equals(fall)
    await setRules('teams', f.teamA, own)
    expect(await rulesOf(game)).deep.equals(own)
    expect(await rulesOf(fallGame)).deep.equals(own)
    // The visitors have none of their own, so the game's season's hold, as
    // a coach of theirs reads them.
    const visitorsCoach = makeId('scopeRole')
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: visitorsCoach,
        user_id: userIdOfGumbo(TEAM_COACH),
        scope_type: 'team',
        scope_id: f.standaloneTeam,
        role: 'coach'
      })
      .execute()
    try {
      expect((await plans(game)).away?.rules).deep.equals(spring)
    } finally {
      await f.h.db
        .deleteFrom('scope_roles')
        .where('id', '=', visitorsCoach)
        .execute()
    }
  })

  /** The notices heard since `forgetHeard`, up to a mark sent now. */
  const heardNow = async (): Promise<Array<Record<string, unknown>>> => {
    const mark = makeId('game')
    await sql`select pg_notify(${GAME_CHANGES_CHANNEL}, ${JSON.stringify({ mark })})`.execute(
      f.h.db
    )
    while (!heard.some(payload => payload.mark === mark))
      await new Promise(resolve => setTimeout(resolve, 5))
    return heard.filter(payload => payload.mark == null)
  }
  /**
   * Puts a game where its scorer has it: started an hour ago (or starting in
   * an hour), its at-bat in `inning` (none when null), and its status.
   */
  const placeGame = async (
    gameId: string,
    changes: {
      inning: number | null
      started?: boolean
      status?: 'scheduled' | 'inProgress' | 'final' | 'cancelled'
    }
  ): Promise<void> => {
    await f.h.db
      .updateTable('games')
      .set({
        start_at: new Date(
          Date.now() + (changes.started === false ? 1 : -1) * 3600_000
        ),
        status: changes.status ?? 'inProgress',
        // As the scoring document posts it, a batter up or not.
        currentPlay:
          changes.inning == null
            ? null
            : JSON.stringify({
                about: {
                  atBatIndex: 4,
                  inning: changes.inning,
                  halfInning: 'top',
                  isTopInning: true,
                  isComplete: false,
                  hasOut: false,
                  hasReview: false
                }
              })
      })
      .where('id', '=', gameId)
      .execute()
  }
  const inningOf = async (
    gameId: string,
    teamId: string,
    inning: number | string,
    userId: number = f.people.scorekeeper
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const answer = await f.h.request(
      'GET',
      `/games/${gameId}/plans/${teamId}/innings/${inning}`,
      undefined,
      userId
    )
    return {
      status: answer.status,
      body: (await answer.json()) as Record<string, unknown>
    }
  }
  const reasonOf = (body: Record<string, unknown>): unknown =>
    (body.details as { reason?: unknown } | undefined)?.reason

  it('names as a plan’s coaches only those given the coach or the assistant flag on the team, its season or its league', async function () {
    const g = await f.h.db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id'])
      .where('id', '=', game)
      .executeTakeFirstOrThrow()
    const teams = async (id: number): Promise<string[]> =>
      await planTeams(f.h.db, userIdOfGumbo(id), g)
    expect(await teams(f.people.teamCoach)).deep.equals([f.teamA])
    expect(await teams(f.people.seasonCoach)).deep.equals([f.teamA])
    expect(await teams(f.people.assistant)).deep.equals([f.teamA])
    for (const id of [
      f.people.admin,
      f.people.siteAdmin,
      f.people.scorekeeper,
      f.people.follower
    ])
      expect(await teams(id), String(id)).deep.equals([])
    // The administrator, given the flag, coaches it.
    const role = makeId('scopeRole')
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: role,
        user_id: userIdOfGumbo(f.people.admin),
        scope_type: 'team',
        scope_id: f.teamA,
        role: 'coach'
      })
      .execute()
    try {
      expect(await teams(f.people.admin)).deep.equals([f.teamA])
    } finally {
      await f.h.db.deleteFrom('scope_roles').where('id', '=', role).execute()
    }
  })

  it('answers a scorer the inning in play, every row by jersey and nothing else, once the game has started', async function () {
    const at = await newGame('2027-04-11T17:00:00Z')
    await saved(
      at,
      planOf([
        [DECKER, 'SS P 1B'],
        [SORIANO, 'C _ C'],
        [BERRA, '1B 1B _'],
        [CHAPMAN, '_ C P']
      ])
    )
    await placeGame(at, { inning: 2 })
    const read = await inningOf(at, f.teamA, 2)
    expect(read.status, JSON.stringify(read.body)).equals(200)
    expect(read.body).deep.equals({
      teamId: f.teamA,
      inning: 2,
      column: [
        { player: SORIANO, cell: '' },
        { player: BERRA, cell: '1B' },
        { player: CHAPMAN, cell: 'C' },
        { player: DECKER, cell: 'P' }
      ]
    })
    // A coach of the team reads it too; the other side's plan is empty.
    expect((await inningOf(at, f.teamA, 2, f.people.teamCoach)).status).equals(
      200
    )
    expect((await inningOf(at, f.standaloneTeam, 2)).body.column).deep.equals(
      []
    )
    // An inning past the plan's last is empty.
    await placeGame(at, { inning: 4 })
    expect((await inningOf(at, f.teamA, 4)).body.column).deep.equals([])
  })

  it('refuses the inning before the start time, once the game is over, and for any inning but the one in play', async function () {
    const at = await newGame('2027-04-12T17:00:00Z')
    await saved(at, planOf([[SORIANO, 'SS 2B 1B']]))
    // The innings moved on before the start time expose nothing.
    await placeGame(at, { inning: 3, started: false })
    const early = await inningOf(at, f.teamA, 3)
    expect(early.status).equals(403)
    expect(reasonOf(early.body)).equals('planNotStarted')
    await placeGame(at, { inning: 2 })
    const next = await inningOf(at, f.teamA, 3)
    expect(next.status).equals(409)
    expect(next.body.details).deep.equals({
      reason: 'planInningNotCurrent',
      inning: 2
    })
    expect(reasonOf((await inningOf(at, f.teamA, 1)).body)).equals(
      'planInningNotCurrent'
    )
    // A game finalized after two never exposes the third.
    await placeGame(at, { inning: null, status: 'final' })
    const over = await inningOf(at, f.teamA, 3)
    expect(over.status).equals(403)
    expect(reasonOf(over.body)).equals('planGameOver')
    await placeGame(at, { inning: 2, status: 'cancelled' })
    expect(reasonOf((await inningOf(at, f.teamA, 2)).body)).equals(
      'planGameOver'
    )
    // A live game with no at-bat stored has no inning in play.
    await placeGame(at, { inning: null })
    expect((await inningOf(at, f.teamA, 2)).body.details).deep.equals({
      reason: 'planInningNotCurrent',
      inning: null
    })
  })

  it('takes the pregame as the 1st, and refuses whoever neither scores nor coaches, a team not in the game and an inning out of range', async function () {
    const at = await newGame('2027-04-13T17:00:00Z')
    await saved(at, planOf([[SORIANO, 'SS 2B']]))
    await placeGame(at, { inning: null })
    await f.h.db
      .updateTable('games')
      .set({ pregame: JSON.stringify({}) })
      .where('id', '=', at)
      .execute()
    expect((await inningOf(at, f.teamA, 1)).body.column).deep.equals([
      { player: SORIANO, cell: 'SS' }
    ])
    // The assistant reads it as a coach does; a member who neither scores
    // nor coaches does not.
    expect((await inningOf(at, f.teamA, 1, f.people.assistant)).status).equals(
      200
    )
    expect((await inningOf(at, f.teamA, 1, f.people.guardian)).status).equals(
      403
    )
    // A follower does not see the game at all.
    expect((await inningOf(at, f.teamA, 1, f.people.follower)).status).equals(
      404
    )
    expect((await inningOf(at, f.rookies, 1)).status).equals(404)
    for (const inning of ['0', '13', '1.5', 'x'])
      expect((await inningOf(at, f.teamA, inning)).status, inning).equals(404)
    expect((await inningOf('gam_nothere', f.teamA, 1)).status).equals(404)
  })

  it('announces a save only when it changes the inning in play of a started game, naming the team and the inning', async function () {
    const at = await newGame('2027-04-14T17:00:00Z')
    await placeGame(at, { inning: 2 })
    await forgetHeard()
    // A first save plans the inning in play.
    await saved(at, planOf([[SORIANO, 'SS 2B 1B 1B']]))
    // Only later innings change.
    await saved(at, planOf([[SORIANO, 'SS 2B LF LF']]))
    // Refused saves announce nothing.
    expect((await put(at, f.teamA, { innings: 99 })).status).equals(400)
    expect(
      (await put(at, f.teamA, planOf([[SORIANO, 'SS']]), f.people.guardian))
        .status
    ).equals(403)
    // The inning in play changes.
    await saved(at, planOf([[SORIANO, 'SS CF LF LF']]))
    const notices = await heardNow()
    expect(notices).deep.equals([
      { game: at, kind: 'plans', teamId: f.teamA, inning: 2 },
      { game: at, kind: 'plans', teamId: f.teamA, inning: 2 }
    ])
    expect(asGameChangePayload(notices[0])).deep.equals(notices[0])
    // Before the start time, and once the game is over, nothing is heard.
    await forgetHeard()
    await placeGame(at, { inning: 2, started: false })
    await saved(at, planOf([[SORIANO, 'SS P LF LF']]))
    await placeGame(at, { inning: null, status: 'final' })
    await saved(at, planOf([[SORIANO, 'SS C LF LF']]))
    expect(await heardNow()).deep.equals([])
  })

  it('announces every save that changes the inning in play, however two saves overlap', async function () {
    const at = await newGame('2027-04-15T17:00:00Z')
    await placeGame(at, { inning: 2 })
    const before = planOf([[SORIANO, 'SS 2B 1B']])
    const changed = planOf([[SORIANO, 'SS CF 1B']])
    for (let attempt = 0; attempt < 5; attempt++) {
      await saved(at, before)
      await forgetHeard()
      // One changes the inning in play, the other puts it back.
      const answers = await Promise.all([
        put(at, f.teamA, changed),
        put(at, f.teamA, before)
      ])
      expect(answers.map(answer => answer.status)).deep.equals([200, 200])
      const stored = await f.h.db
        .selectFrom('game_plans')
        .select('rows')
        .where('game_id', '=', at)
        .executeTakeFirstOrThrow()
      const notices = (await heardNow()).filter(notice => notice.game === at)
      // Ending where it began, both changed it in turn: two notices, so the
      // scorer reads the column back. Ending changed, at least one.
      if (JSON.stringify(stored.rows) === JSON.stringify(before.rows))
        expect(notices, `attempt ${attempt}`).has.length(2)
      else expect(notices.length, `attempt ${attempt}`).greaterThan(0)
    }
  })

  it('reads a plans notice, and refuses one that names no team or no inning', function () {
    expect(
      asGameChangePayload({
        game: 'gam_1',
        kind: 'plans',
        teamId: 'tem_1',
        inning: 3
      })
    ).deep.equals({ game: 'gam_1', kind: 'plans', teamId: 'tem_1', inning: 3 })
    expect(() =>
      asGameChangePayload({ game: 'gam_1', kind: 'plans', inning: 3 })
    ).throws()
    expect(() =>
      asGameChangePayload({ game: 'gam_1', kind: 'plans', teamId: 'tem_1' })
    ).throws()
    expect(() =>
      asGameChangePayload({
        game: 'gam_1',
        kind: 'plans',
        team: 'tem_1',
        inning: 3
      })
    ).throws()
  })
})
