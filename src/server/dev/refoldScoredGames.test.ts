import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { defaultRadarSettings } from '../../common/nodeSettings'
import type { ScoringAction } from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/apply'
import { freshGame, newSetup } from '../../common/scoring/lineup'
import { radarTargets, withRadarSpeeds } from '../../common/scoring/radarSpeeds'
import {
  type EventStore,
  ScoringSession,
  type SessionContext
} from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { type Database, makeDatabase } from '../db/database'
import { replaceGameEvents } from '../events/eventWrite'
import { postGamePlays } from '../events/postPlays'
import { readPlays } from '../routes/events'
import { refoldScoredGames, runRefold } from './refoldScoredGames'

/**
 * The refold against a scratch database: games scored through a session that
 * posts as the app does, then stored plays put back into the shape they had
 * before the runners were Gumbo's.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_refold_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const home = makeId('team')
const away = makeId('team')
const held = new Set<number>()
const minted = Array.from({ length: 18 }, () => {
  const made = mintUserId(id => held.has(id))
  held.add(made.userId)
  return made
})
const AWAY = minted.slice(0, 9).map(made => made.userId)
const HOME = minted.slice(9).map(made => made.userId)
const TEAMS = {
  away: { id: away, name: 'Away', logoUrl: null },
  home: { id: home, name: 'Home', logoUrl: null }
}
const setup = newSetup(TEAMS, {
  away: AWAY.map((userId, i) => ({
    userId: userIdOfGumbo(userId),
    gumboId: userId,
    shortName: `Away ${i + 1}`
  })),
  home: HOME.map((userId, i) => ({
    userId: userIdOfGumbo(userId),
    gumboId: userId,
    shortName: `Home ${i + 1}`
  }))
})

const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }
const single: ScoringAction[] = [
  { type: 'ballInPlay', contact: 'swing', fielder: HOME[4] },
  { type: 'result', eventType: 'single' }
]
const double: ScoringAction[] = [
  { type: 'ballInPlay', contact: 'swing', fielder: HOME[7] },
  { type: 'result', eventType: 'double' },
  { type: 'runnerMovement', runner: AWAY[0], to: 'home' }
]
const strikeout = [strike, strike, strike, close]

/** A base as the plays stored before the runners were Gumbo's. */
function oldBase(base: unknown): number {
  return base === 'score' ? 4 : typeof base === 'string' ? Number(base[0]) : 0
}
/** A stored play put back into that older shape. */
function oldShape<T extends Record<string, unknown>>(doc: T): T {
  const copy = structuredClone(doc) as Record<string, unknown>
  const runners = (copy.runners ?? []) as Array<{
    movement: Record<string, unknown>
    details: Record<string, unknown>
    credits: Array<{ position?: { abbreviation: string } }>
  }>
  copy.runners = runners.map(runner => ({
    movement: {
      originBase: oldBase(runner.movement.start),
      start: oldBase(runner.movement.start),
      end: oldBase(runner.movement.end ?? runner.movement.outBase),
      isOut: runner.movement.isOut,
      forceOut: false,
      runScored: runner.movement.end === 'score'
    },
    details: { runner: runner.details.runner, movementReason: 'Advance' },
    credits: runner.credits.map(credit => ({
      ...credit,
      position: { abbreviation: credit.position?.abbreviation ?? '' }
    }))
  }))
  return copy as T
}

describe('refolding the stored plays (U11)', function () {
  this.timeout(60000)

  let admin: Pool
  let db: Kysely<Database>
  const context = (gameId: string): SessionContext => ({
    gamePk: gameId,
    teams: TEAMS,
    setup
  })

  /** Where a session reads and writes: the database, as a scorer posts. */
  const store: EventStore = {
    load: async gameId => {
      const game = await db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      return {
        plays: (await readPlays(db, gameId)).map(row => row.gumbo as GumboPlay),
        currentPlay: game.currentPlay as CurrentPlay | null
      }
    },
    save: async (gameId, change) => {
      await postGamePlays(
        db,
        gameId,
        asPostEventsBody({
          ...change,
          mode: 'live',
          source: { system: 'teamstation' }
        })
      )
      return await store.load(gameId)
    }
  }

  async function newGame(): Promise<string> {
    const id = makeId('game')
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date()
      })
      .execute()
    return id
  }
  async function score(
    gameId: string,
    actions: ScoringAction[]
  ): Promise<void> {
    let now = Date.parse('2026-09-25T18:00:00Z')
    const session = await ScoringSession.open(store, gameId, context(gameId), {
      now: () => new Date((now += 60000)),
      setTimer: () => null,
      clearTimer: () => undefined
    })
    for (const action of actions) {
      expect(
        session.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
      await session.flush()
    }
  }
  /** Every stored play and the at-bat in progress back in the older shape. */
  async function makeOld(gameId: string): Promise<void> {
    for (const row of await readPlays(db, gameId))
      await db
        .updateTable('events')
        .set({ gumbo: JSON.stringify(oldShape(row.gumbo as GumboPlay)) })
        .where('id', '=', row.id)
        .execute()
    const game = await db
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    if (game.currentPlay != null)
      await db
        .updateTable('games')
        .set({
          currentPlay: JSON.stringify(
            oldShape(game.currentPlay as Record<string, unknown>)
          )
        })
        .where('id', '=', gameId)
        .execute()
  }
  async function snapshot(gameId: string): Promise<unknown> {
    return {
      rows: await db
        .selectFrom('events')
        .select(['id', 'atBatIndex', 'gumbo', 'startTime', 'endTime'])
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex')
        .execute(),
      game: await db
        .selectFrom('games')
        .select(['currentPlay', 'linescore', 'status'])
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
    }
  }

  let finished = ''
  let midPlay = ''
  let broken = ''
  let imported = ''
  let mixed = ''

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query('select 1')
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const now = new Date()
    await db
      .insertInto('teams')
      .values([
        { id: home, name: 'Home', kind: 'full' },
        { id: away, name: 'Away', kind: 'full' }
      ])
      .execute()
    await insertFixtureUsers(
      db,
      minted.map((made, i) => ({
        id: made.userId,
        legacyId: made.legacyId,
        display_name: `Player ${i}`,
        created_at: now,
        updated_at: now
      }))
    )

    // A finished game: a run on a double, then three out, then End Game.
    finished = await newGame()
    await score(finished, [
      ...single,
      close,
      ...double,
      close,
      ...strikeout,
      ...strikeout,
      ...strikeout,
      { type: 'gameFlow', kind: 'endGame' }
    ])
    await makeOld(finished)

    // Left in the middle of an at-bat: a steal of second, two balls thrown.
    midPlay = await newGame()
    await score(midPlay, [
      ...single,
      close,
      { type: 'baseRunning', kind: 'steal', runner: AWAY[0] },
      ball,
      ball
    ])
    await makeOld(midPlay)

    // A log that no longer replays: strike three dropped before any strike.
    broken = await newGame()
    await score(broken, [...single, close, ball])
    await db
      .updateTable('games')
      .set({
        currentPlay: JSON.stringify({
          ...((await store.load(broken)).currentPlay as object),
          teamStation: {
            version: 3,
            setupBefore: (
              (await store.load(broken)).plays[0] as unknown as {
                teamStation: { setupBefore: unknown }
              }
            ).teamStation.setupBefore,
            actions: [{ type: 'result', eventType: 'strikeout' }]
          }
        })
      })
      .where('id', '=', broken)
      .execute()

    // A game an outside scorer sent, which TeamStation never scored.
    imported = await newGame()
    await replaceGameEvents(db, {
      gameId: imported,
      homeTeamId: home,
      awayTeamId: away,
      plays: [0, 1].map(atBatIndex => ({
        gumbo: {
          about: { atBatIndex, inning: 1, halfInning: 'top' },
          result: { eventType: 'single', awayScore: 0, homeScore: 0 },
          count: { outs: 0 },
          runners: [{ movement: { end: '1B' } }]
        } as unknown as GumboPlay,
        source: 'external' as const
      }))
    })

    // Imported plays first, then scored in TeamStation from there.
    mixed = await newGame()
    await replaceGameEvents(db, {
      gameId: mixed,
      homeTeamId: home,
      awayTeamId: away,
      plays: [
        {
          gumbo: {
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'strikeout', awayScore: 0, homeScore: 0 },
            count: { outs: 1 },
            matchup: { batter: { id: AWAY[0] } },
            runners: []
          } as unknown as GumboPlay,
          source: 'external'
        }
      ]
    })
    await score(mixed, [...single, close, ball])
    await makeOld(mixed)
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('lists what a preview would write and writes nothing, and takes --dry-run for --preview', async function () {
    const before = await snapshot(finished)
    for (const flag of ['--preview', '--dry-run']) {
      const lines: string[] = []
      expect(
        await runRefold(db, ['--game', finished, flag], line =>
          lines.push(line)
        )
      ).equals(0)
      expect(lines).deep.equals([
        `changed ${finished}: would write 6 plays`,
        '1 changed, 0 unchanged, 0 skipped (preview)'
      ])
      expect(await snapshot(finished)).deep.equals(before)
    }
  })

  it('says so when --game names no game, or the arguments are wrong', async function () {
    const lines: string[] = []
    const print = (line: string): void => {
      lines.push(line)
    }
    expect(await runRefold(db, ['--game', 'gam_nothere'], print)).equals(1)
    expect(await runRefold(db, ['--game'], print)).equals(1)
    expect(await runRefold(db, ['--games', '2'], print)).equals(1)
    expect(lines).deep.equals([
      'no such game: gam_nothere',
      'Usage: npm run refold-scored-games -- [--game <id>] [--preview]',
      'Usage: npm run refold-scored-games -- [--game <id>] [--preview]'
    ])
  })

  it('refolds every game it can, skips the one that does not replay, and changes nothing the second time', async function () {
    // A reset left this game on a later play generation; the refold, a
    // server write, is not checked against it (S15).
    await db
      .updateTable('games')
      .set({ play_generation: 2 })
      .where('id', '=', finished)
      .execute()
    const importedBefore = await snapshot(imported)
    const brokenBefore = await snapshot(broken)
    const finishedBefore = (await snapshot(finished)) as {
      rows: Array<{
        id: string
        atBatIndex: number
        startTime: Date
        gumbo: { about: { startTime: string } }
      }>
    }
    const mixedBefore = (await snapshot(mixed)) as {
      rows: Array<{ atBatIndex: number; gumbo: unknown }>
    }

    const lines: string[] = []
    expect(await runRefold(db, [], line => lines.push(line))).equals(1)
    expect(lines).to.include(`changed ${finished}: wrote 6 plays`)
    expect(lines).to.include(
      `changed ${midPlay}: wrote 1 plays, and the at-bat in progress`
    )
    expect(lines).to.include(`changed ${mixed}: wrote 1 plays`)
    expect(lines).to.include(
      `skipped ${broken}: Requires two strikes and first empty or two outs`
    )
    expect(lines.at(-1)).equals('3 changed, 0 unchanged, 1 skipped')

    // Untouched: the game that does not replay, and the imported one.
    expect(await snapshot(broken)).deep.equals(brokenBefore)
    expect(await snapshot(imported)).deep.equals(importedBefore)
    // The imported play before TeamStation's is left as it was.
    const mixedAfter = (await snapshot(mixed)) as typeof mixedBefore
    expect(mixedAfter.rows[0].gumbo).deep.equals(mixedBefore.rows[0].gumbo)

    // Each play keeps its row and its times, and is Gumbo's shape now.
    const finishedAfter = (await snapshot(finished)) as typeof finishedBefore
    expect(
      finishedAfter.rows.map(row => [
        row.id,
        row.startTime.toISOString(),
        row.gumbo.about.startTime
      ])
    ).deep.equals(
      finishedBefore.rows.map(row => [
        row.id,
        row.startTime.toISOString(),
        row.gumbo.about.startTime
      ])
    )
    const double = finishedAfter.rows[1].gumbo as unknown as {
      runners: Array<{
        movement: { end: unknown }
        details: Record<string, unknown>
      }>
      about: { halfOuts?: number }
    }
    expect(double.runners.map(r => r.movement.end)).deep.equals([
      '3B',
      '2B',
      'score'
    ])
    const last = finishedAfter.rows.at(-2)!.gumbo as unknown as {
      about: { halfOuts?: number }
      credits: Array<{ teamId: string }>
    }
    expect(last.about.halfOuts).equals(3)
    expect(last.credits[0].teamId).equals(home)

    // The at-bat in progress is Gumbo's too.
    const current = (await store.load(midPlay)).currentPlay as unknown as {
      runners: Array<{ movement: { end: unknown } }>
    }
    expect(current.runners.map(r => r.movement.end)).deep.equals(['2B'])
    const again = await refoldScoredGames(db)
    expect(again!.changed).deep.equals([])
    expect(again!.unchanged).to.include.members([finished, midPlay, mixed])
    expect(again!.unchanged).not.to.include(imported)
    // Named on its own, a game TeamStation never scored has nothing to do.
    const alone = await refoldScoredGames(db, { gameId: imported })
    expect(alone).deep.equals({
      changed: [],
      unchanged: [imported],
      skipped: []
    })
    expect(again!.skipped.map(game => game.gameId)).deep.equals([broken])
  })

  it('removes a play an undo took back that the old code left stored, and says so first on a preview', async function () {
    // The walk was undone back to the close of the single before it, but its
    // row stayed: the at-bat in progress is the walk's index again, holding
    // only that close.
    const undone = await newGame()
    await score(undone, [...single, close])
    const reopened = (await store.load(undone)).currentPlay
    await score(undone, [ball, ball, ball, ball, close])
    await db
      .updateTable('games')
      .set({ currentPlay: JSON.stringify(reopened) })
      .where('id', '=', undone)
      .execute()
    const before = await snapshot(undone)
    const lines: string[] = []
    const print = (line: string): void => {
      lines.push(line)
    }
    expect(await runRefold(db, ['--game', undone, '--preview'], print)).equals(
      0
    )
    expect(await snapshot(undone)).deep.equals(before)
    expect(await runRefold(db, ['--game', undone], print)).equals(0)
    expect(lines).deep.equals([
      `changed ${undone}: would write 0 plays, would remove the play at 1`,
      '1 changed, 0 unchanged, 0 skipped (preview)',
      `changed ${undone}: wrote 0 plays, removed the play at 1`,
      '1 changed, 0 unchanged, 0 skipped'
    ])
    const rows = (await readPlays(db, undone)).map(row => row.atBatIndex)
    expect(rows).deep.equals([0])
    expect((await store.load(undone)).currentPlay).deep.equals(reopened)
    expect(await refoldScoredGames(db, { gameId: undone })).deep.equals({
      changed: [],
      unchanged: [undone],
      skipped: []
    })
  })

  it('opens a refolded game where it was left, and undoes from there', async function () {
    const session = await ScoringSession.open(store, midPlay, context(midPlay))
    expect(session.pending).equals(0)
    expect(session.state.liveData.linescore.balls).equals(2)
    expect(session.state.liveData.linescore.offense.second).not.equals(null)
    session.undo()
    await session.flush()
    const current = (await store.load(midPlay)).currentPlay as unknown as {
      playEvents: unknown[]
    }
    expect(current.playEvents).length(2)
    const refolded = await refoldScoredGames(db, { gameId: midPlay })
    expect(refolded!.changed).deep.equals([])
  })

  it('leaves a game whose rebuilt plays would name another man than the stored ones, and says where', async function () {
    // The stored walk names another batter, or another runner forced from
    // first, than its log makes: rebuilding would change who played.
    const edit = async (
      change: (play: {
        matchup: { batter: unknown }
        runners: Array<{
          movement: { start: unknown }
          details: { runner: unknown }
        }>
      }) => void
    ): Promise<string> => {
      const gameId = await newGame()
      await score(gameId, [...single, close, ball, ball, ball, ball, close])
      const row = (await readPlays(db, gameId)).find(
        play => play.atBatIndex === 1
      )!
      const gumbo = structuredClone(row.gumbo) as Parameters<typeof change>[0]
      change(gumbo)
      await db
        .updateTable('events')
        .set({ gumbo: JSON.stringify(gumbo) })
        .where('id', '=', row.id)
        .execute()
      return gameId
    }
    const other = { id: AWAY[6], fullName: 'Away 7' }
    const batter = await edit(play => {
      play.matchup.batter = other
    })
    const runner = await edit(play => {
      play.runners.find(
        entry => entry.movement.start === '1B'
      )!.details.runner = other
    })
    for (const [gameId, change] of [
      [batter, 'play 1 batter Away 7 → Away 2'],
      [runner, 'play 1 runner from 1B Away 7 → Away 1']
    ]) {
      const before = await snapshot(gameId)
      const lines: string[] = []
      const print = (line: string): void => {
        lines.push(line)
      }
      expect(
        await runRefold(db, ['--game', gameId, '--preview'], print)
      ).equals(1)
      expect(await runRefold(db, ['--game', gameId], print)).equals(1)
      const skipped = `skipped ${gameId}: rebuilding would change who played: ${change}`
      expect(lines).deep.equals([
        skipped,
        '0 changed, 0 unchanged, 1 skipped (preview)',
        skipped,
        '0 changed, 0 unchanged, 1 skipped'
      ])
      expect(await snapshot(gameId)).deep.equals(before)
    }
  })

  it('leaves a game whose log would now name another batter, and says which', async function () {
    // Scored before a man put in a runner's place took his base: the sheet
    // took Away 3 out while he stood on first and added a man at the end,
    // and that code left Away 3 on base and the new man batting tenth.
    // Today the new man runs for Away 3 and bats third, so the tenth plate
    // appearance of the visitors would be Away 1's.
    const old = await newGame()
    const guest = mintUserId(id => held.has(id))
    held.add(guest.userId)
    await insertFixtureUsers(db, {
      id: userIdOfGumbo(guest.userId),
      legacyId: guest.legacyId,
      display_name: 'Bench'
    })
    const first: ScoringAction[] = [
      ...strikeout,
      ...strikeout,
      ...single,
      close,
      {
        type: 'lineup',
        kind: 'addPlayer',
        side: 'away',
        name: 'Bench',
        player: guest.userId
      }
    ]
    let state = freshGame(old, TEAMS, setup)
    for (const action of first) state = applyAction(state, action).state
    // What that code stored: the order as saved, with Away 3 kept in it so
    // that today's code keeps him on base too.
    const saved = setupOf(state)
    const away = saved.sides.away
    away.battingOrder.push(away.players.at(-1)!)
    await score(old, [
      ...first,
      { type: 'lineup', kind: 'roster', setup: saved },
      ...Array.from({ length: 13 }, () => strikeout).flat()
    ])
    // ...and the log it kept: the save that took Away 3 out.
    for (const row of await readPlays(db, old)) {
      // Stored by team: the visitors' lineup is under their team's id.
      const gumbo = row.gumbo as {
        teamStation?: {
          actions: Array<{
            type: string
            kind?: string
            setup?: { teams: Record<string, { battingOrder: number[] }> }
          }>
        }
      }
      const save = gumbo.teamStation?.actions.find(
        action => action.type === 'lineup' && action.kind === 'roster'
      )
      if (save?.setup == null) continue
      save.setup.teams[TEAMS.away.id].battingOrder.splice(2, 1)
      await db
        .updateTable('events')
        .set({ gumbo: JSON.stringify(gumbo) })
        .where('id', '=', row.id)
        .execute()
    }
    const before = await snapshot(old)
    const lines: string[] = []
    const print = (line: string): void => {
      lines.push(line)
    }
    expect(await runRefold(db, ['--game', old, '--preview'], print)).equals(1)
    expect(await runRefold(db, ['--game', old], print)).equals(1)
    const skipped =
      `skipped ${old}: rebuilding would change who played: ` +
      'play 15 batter Bench → Away 1'
    expect(lines).deep.equals([
      skipped,
      '0 changed, 0 unchanged, 1 skipped (preview)',
      skipped,
      '0 changed, 0 unchanged, 1 skipped'
    ])
    expect(await snapshot(old)).deep.equals(before)
  })

  it('stores the speed, zone and location a scorer gave each pitch, and keeps them through a refold', async function () {
    const gameId = await newGame()
    await score(gameId, [
      {
        type: 'pitch',
        call: 'C',
        speed: 64.25,
        pitchLocation: { height: 'low', side: 'away', inZone: true }
      },
      {
        type: 'ballInPlay',
        contact: 'swing',
        fielder: HOME[4],
        speed: 66,
        pitchLocation: { height: 'high', side: 'inside', inZone: false }
      },
      { type: 'result', eventType: 'single' },
      close
    ])
    const pitchData = async (): Promise<unknown[]> => {
      const rows = await readPlays(db, gameId)
      expect(rows).length(1)
      const events = (rows[0].gumbo as GumboPlay).playEvents as Array<{
        isPitch: boolean
        pitchData?: unknown
      }>
      return events.filter(event => event.isPitch).map(event => event.pitchData)
    }
    const stored = [
      {
        startSpeed: 64.3,
        zone: 9,
        location: { height: 'low', side: 'away', inZone: true }
      },
      {
        startSpeed: 66,
        zone: 11,
        location: { height: 'high', side: 'inside', inZone: false }
      }
    ]
    expect(await pitchData()).deep.equals(stored)
    expect(await refoldScoredGames(db, { gameId })).deep.equals({
      changed: [],
      unchanged: [gameId],
      skipped: []
    })
    expect(await pitchData()).deep.equals(stored)
  })

  it('does not repeatedly refold server radar measurements on completed and current plays', async function () {
    const gameId = await newGame()
    await score(gameId, [
      { type: 'pitch', call: 'B' },
      { type: 'ballInPlay', contact: 'swing', fielder: HOME[4] },
      { type: 'result', eventType: 'single' },
      close,
      { type: 'pitch', call: 'C' }
    ])
    const measured = (value: unknown): any => {
      return withRadarSpeeds(
        value,
        radarTargets(value).map((target, i) => ({
          at: target.at,
          version: i + 1,
          pitchSpeed: 82,
          exitVelocity: 94
        })),
        defaultRadarSettings
      )
    }
    const [row] = await readPlays(db, gameId)
    const current = (
      await db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
    ).currentPlay
    await db
      .updateTable('events')
      .set({ gumbo: measured(row.gumbo) })
      .where('id', '=', row.id)
      .execute()
    await db
      .updateTable('games')
      .set({ currentPlay: measured(current) })
      .where('id', '=', gameId)
      .execute()
    for (let i = 0; i < 2; i++)
      expect(await refoldScoredGames(db, { gameId })).deep.equals({
        changed: [],
        unchanged: [gameId],
        skipped: []
      })
    const wrong = measured(row.gumbo)
    wrong.count.balls = 3
    await db
      .updateTable('events')
      .set({ gumbo: wrong })
      .where('id', '=', row.id)
      .execute()
    expect(
      (await refoldScoredGames(db, { gameId }))!.changed.map(
        change => change.gameId
      )
    ).deep.equals([gameId])
    expect((await refoldScoredGames(db, { gameId }))!.unchanged).deep.equals([
      gameId
    ])
    const saved = (await readPlays(db, gameId))[0].gumbo as any
    expect(
      saved.playEvents
        .filter((e: any) => e.isPitch)
        .map((e: any) => e.pitchData.startSpeed)
    ).deep.equals([82, 82])
  })
})
