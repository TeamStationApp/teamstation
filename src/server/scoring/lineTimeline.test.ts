import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import type { ScoringAction } from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/apply'
import { type BoardLine, boardLineOf } from '../../common/scoring/boardLine'
import { freshGame } from '../../common/scoring/lineup'
import {
  type EventStore,
  ScoringSession,
  type SessionContext
} from '../../common/scoring/session'
import {
  addGame,
  addScorableTeams,
  scratchDatabase
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { postGamePlays, readPlays } from '../events/postPlays'
import {
  computeLineTimeline,
  lineStepsFor,
  lineTimelineVersion,
  makeLineTimelineCache
} from './lineTimeline'

/**
 * The line score at every moment (U2), from a game's events alone, on a
 * scratch database. The scorer's clock is the test's, so every step's time
 * is known.
 */
describe('the line timeline (U2)', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let context: Pick<SessionContext, 'teams' | 'setup'>
  let clock = Date.now()

  const swing: ScoringAction = { type: 'ballInPlay', contact: 'swing' }
  const strike: ScoringAction = { type: 'pitch', call: 'C' }
  const homeRun: ScoringAction[] = [
    swing,
    { type: 'result', eventType: 'home_run' },
    { type: 'gameFlow', kind: 'closePlay' }
  ]
  const single: ScoringAction[] = [
    swing,
    { type: 'result', eventType: 'single' }
  ]
  const strikeout: ScoringAction[] = [strike, strike, strike]

  const load = async (gameId: string): ReturnType<EventStore['load']> => {
    const game = await db
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    return {
      plays: (await readPlays(db, gameId)).map(row => row.gumbo as GumboPlay),
      currentPlay: game.currentPlay as CurrentPlay | null
    }
  }
  const store: EventStore = {
    load,
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
      return await load(gameId)
    }
  }

  /** Scores each action a second after the last, as the app posts them. */
  async function score(
    gameId: string,
    actions: ScoringAction[]
  ): Promise<number[]> {
    const session = await ScoringSession.open(
      store,
      gameId,
      { gamePk: gameId, ...context },
      {
        now: () => new Date(clock),
        setTimer: () => null,
        clearTimer: () => undefined
      }
    )
    const times: number[] = []
    for (const action of actions) {
      clock += 1000
      times.push(clock)
      expect(
        session.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
      await session.flush()
    }
    return times
  }

  /** The line after each action, collapsed to its changes. */
  function expected(
    gameId: string,
    actions: ScoringAction[],
    times: number[]
  ): Array<{ at: number; line: BoardLine }> {
    let state = freshGame(gameId, context.teams, context.setup)
    const out: Array<{ at: number; line: BoardLine }> = []
    actions.forEach((action, i) => {
      state = applyAction(state, action).state
      const line = boardLineOf(state)
      if (JSON.stringify(out.at(-1)?.line) !== JSON.stringify(line))
        out.push({ at: times[i], line })
    })
    return out
  }

  const newGame = async (startAt = new Date(clock)): Promise<string> =>
    await addGame(db, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id,
      startAt
    })

  before(async function () {
    ;({ db, drop } = await scratchDatabase('line_timeline'))
    context = await addScorableTeams(db, { home: 'Owls', away: 'Herons' })
  })

  beforeEach(function () {
    clock = Date.now()
  })

  after(async function () {
    await drop?.()
  })

  it('steps with each run, hit and half, at the action that made it', async function () {
    const gameId = await newGame()
    const actions = [
      ...homeRun,
      ...single,
      ...strikeout,
      ...strikeout,
      ...strikeout,
      ...homeRun
    ]
    const times = await score(gameId, actions)
    const timeline = await computeLineTimeline(db, gameId)
    expect(timeline?.steps).deep.equals(expected(gameId, actions, times))
    expect(timeline?.teams).deep.equals({ away: 'Herons', home: 'Owls' })
    expect(timeline?.version).equals(await lineTimelineVersion(db, gameId))
    const last = timeline!.steps.at(-1)!.line
    expect(last.away).deep.equals({ innings: [1], r: 1, h: 2, e: 0 })
    expect(last.home).deep.equals({ innings: [1], r: 1, h: 1, e: 0 })
  })

  it('steps when only the hits change', async function () {
    const gameId = await newGame()
    const times = await score(gameId, [...single])
    const steps = (await computeLineTimeline(db, gameId))!.steps
    expect(steps.map(step => step.line.away.h)).deep.equals([0, 1])
    expect(steps.map(step => step.line.away.r)).deep.equals([0, 0])
    expect(steps.at(-1)!.at).equals(times[1])
  })

  it("puts a play's actions at its end without action times, and a game with none at its start", async function () {
    const gameId = await newGame()
    await score(gameId, [...homeRun, ...strikeout])
    await sql`update events set gumbo = gumbo #- '{teamStation,actionTimes}' where "gameId" = ${gameId}`.execute(
      db
    )
    await sql`update games set "currentPlay" = "currentPlay" #- '{teamStation,actionTimes}' where id = ${gameId}`.execute(
      db
    )
    const ends = (
      await db
        .selectFrom('events')
        .select(['endTime'])
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex')
        .execute()
    ).map(row => new Date(row.endTime!).getTime())
    const steps = (await computeLineTimeline(db, gameId))!.steps
    // The home run's play ended with it: its line is at that play's end.
    const scored = steps.find(step => step.line.away.r === 1)
    expect(scored?.at).equals(ends[0])

    const start = clock - 3_600_000
    const untimed = await newGame(new Date(start))
    await score(untimed, [strike])
    await sql`update games set "currentPlay" = jsonb_set("currentPlay" #- '{teamStation,actionTimes}', '{about,startTime}', 'null') where id = ${untimed}`.execute(
      db
    )
    const lone = (await computeLineTimeline(db, untimed))!.steps
    expect(lone.map(step => step.at)).deep.equals([start])
  })

  it('has no steps without events, whatever the scoreboard log says', async function () {
    const gameId = await newGame()
    await db
      .insertInto('scoreboard_log')
      .values({
        game_id: gameId,
        version: 1,
        at: new Date(clock),
        cause: 'dashboard',
        actor_id: null,
        publisher: null,
        radar: JSON.stringify({}),
        overrides: JSON.stringify({
          overrideScoreEnabled: true,
          overrideScore: { awayScore: 3, homeScore: 2 }
        })
      })
      .execute()
    const timeline = await computeLineTimeline(db, gameId)
    expect(timeline?.steps).deep.equals([])
    expect(await computeLineTimeline(db, 'gam_nothere')).equals(undefined)
  })

  it("follows an imported game's plays at their ends", async function () {
    const gameId = await newGame()
    const at = (seconds: number): string =>
      new Date(clock + seconds * 1000).toISOString()
    const play = (
      index: number,
      inning: number,
      half: 'top' | 'bottom',
      end: number,
      score: [number, number],
      eventType: string
    ): unknown => ({
      about: {
        atBatIndex: index,
        inning,
        halfInning: half,
        startTime: at(end - 1),
        endTime: at(end)
      },
      count: { outs: 3 },
      result: { eventType, awayScore: score[0], homeScore: score[1] }
    })
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        plays: [
          play(0, 1, 'top', 10, [1, 0], 'home_run'),
          play(1, 1, 'bottom', 20, [1, 0], 'strikeout'),
          play(2, 2, 'top', 30, [1, 0], 'field_error')
        ],
        mode: 'replace',
        source: { system: 'external' }
      })
    )
    const steps = (await computeLineTimeline(db, gameId))!.steps
    expect(steps.map(step => step.at)).deep.equals([
      clock + 10_000,
      clock + 20_000,
      clock + 30_000
    ])
    expect(steps[0].line.away).deep.equals({
      innings: [1],
      r: 1,
      h: 1,
      e: 0
    })
    expect(steps[2].line.home.e).equals(1)
    expect(steps[2].line.home.innings).deep.equals([0, null])
  })

  it('answers one instant, a window or all of it', function () {
    const line = (r: number): BoardLine => ({
      away: { innings: [r], r, h: r, e: 0 },
      home: { innings: [null], r: 0, h: 0, e: 0 }
    })
    const steps = [
      { at: 100, line: line(0) },
      { at: 200, line: line(1) },
      { at: 300, line: line(2) }
    ]
    expect(lineStepsFor(steps, { at: 50 })).deep.equals([])
    expect(lineStepsFor(steps, { at: 250 })).deep.equals([steps[1]])
    expect(lineStepsFor(steps, { at: 300 })).deep.equals([steps[2]])
    expect(lineStepsFor(steps, { from: 250, to: 300 })).deep.equals([
      steps[1],
      steps[2]
    ])
    expect(lineStepsFor(steps, { to: 150 })).deep.equals([steps[0]])
    expect(lineStepsFor(steps, {})).deep.equals(steps)
  })

  it('builds once per version and forgets the oldest', async function () {
    const gameId = await newGame()
    let builds = 0
    const cache = makeLineTimelineCache(1, async (db, id) => {
      builds++
      return await computeLineTimeline(db, id)
    })
    const [one, two] = await Promise.all([
      cache.get(db, gameId),
      cache.get(db, gameId)
    ])
    expect(one).equals(two)
    expect(builds).equals(1)
    await score(gameId, [strike])
    expect((await cache.get(db, gameId))?.steps.length).equals(1)
    expect(builds).equals(2)
    const other = await newGame()
    await cache.get(db, other)
    await cache.get(db, gameId)
    expect(builds).equals(4)
    expect(await cache.get(db, 'gam_nothere')).equals(undefined)
  })
})
