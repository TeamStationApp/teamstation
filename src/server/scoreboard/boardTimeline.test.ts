import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { mintUserId } from '../../common/mintUserId'
import {
  composeScoreboard,
  NO_OVERRIDES,
  SAMPLE_SCOREBOARD,
  type ScoreboardState
} from '../../common/scoreboard'
import type { ScoringAction } from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/apply'
import { freshGame, newSetup } from '../../common/scoring/lineup'
import { scoreboardOfGame } from '../../common/scoring/scoreboardOf'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type SessionContext
} from '../../common/scoring/session'
import {
  addGame,
  addPerson,
  addTeam,
  connectedClient,
  dropPrefix,
  type Person,
  quiet,
  requireRedis,
  scratchDatabase,
  situationActions,
  testPrefix,
  until
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { postGamePlays, readPlays } from '../events/postPlays'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { openApiDocument } from '../openapi'
import { eventRoutes } from '../routes/events'
import { scoreboardRoutes } from '../routes/scoreboard'
import { attachScoreboard } from './attachScoreboard'
import {
  type BoardStep,
  computeBoardTimeline,
  makeBoardTimelineCache,
  stepsInWindow,
  timelineVersion
} from './boardTimeline'
import { gameWrittenHook } from './gameSource'
import { makeScoreboardHub } from './scoreboardHub'
import {
  makeScoreboardStore,
  makeScoreboardSubscriber,
  type ScoreboardStore
} from './scoreboardStore'

/**
 * The board timeline (U11–U17), on a scratch database and a real Redis, with
 * two workers, each a real HTTP server with the play post, the scoreboard
 * routes and the hub, as the cluster runs them. The scorer's clock and the
 * store's are the test's, so every step's time is known.
 */

const HOUR = 3_600_000

interface Worker {
  base: string
  ws: string
  store: ScoreboardStore
  close: () => Promise<void>
}

interface Probe {
  socket: WebSocket
  /** Each message as it came, unparsed. */
  texts: string[]
  opened: Promise<void>
  closed: Promise<number>
}

describe('the board timeline', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let prefix = ''
  let clock = Date.now()
  const now = (): number => clock
  let runner: Person
  let stranger: Person
  let teams: SessionContext['teams']
  let setup: SessionContext['setup']
  /** The home bench player, and the second baseman he can replace. */
  let bench = 0
  let secondBaseman = 0
  const workers: Worker[] = []
  const probes: Probe[] = []
  const logged: string[] = []
  const log = (line: string): void => {
    logged.push(line)
  }

  async function startWorker(
    options: { checkMs?: number } = {}
  ): Promise<Worker> {
    const client = await connectedClient()
    const subscriber = makeScoreboardSubscriber(client, quiet)
    await subscriber.connect()
    const store = makeScoreboardStore({ client, prefix, now })
    const hub = makeScoreboardHub({
      db,
      store,
      subscriber,
      log,
      now,
      // The test's clock stands still, so the real hold never fires.
      speedHoldMs: HOUR,
      checkMs: options.checkMs
    })
    const app = express()
    app.use(withActor(db))
    app.use(jsonBody)
    app.use(
      '/api/v1',
      eventRoutes(db, { onGameWritten: gameWrittenHook({ db, store, log }) })
    )
    app.use('/api/v1', scoreboardRoutes(db, store))
    app.use(errorHandler)
    const server: Server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const close = attachScoreboard(server, hub)
    const port = (server.address() as AddressInfo).port
    const worker: Worker = {
      base: `http://127.0.0.1:${port}/api/v1`,
      ws: `ws://127.0.0.1:${port}/api/v1/scoreboard`,
      store,
      close: async () => {
        await close()
        server.closeAllConnections()
        server.close()
      }
    }
    workers.push(worker)
    return worker
  }

  function connect(url: string, who?: Person): Probe {
    const socket = new WebSocket(url, {
      headers: who == null ? {} : { authorization: `Bearer ${who.token}` }
    })
    const probe: Probe = {
      socket,
      texts: [],
      opened: new Promise(resolve =>
        socket.once('open', () => {
          resolve()
        })
      ),
      closed: new Promise(resolve =>
        socket.once('close', code => {
          resolve(code)
        })
      )
    }
    socket.on('message', data => {
      probe.texts.push((data as Buffer).toString('utf8'))
    })
    socket.on('error', () => undefined)
    probes.push(probe)
    return probe
  }
  async function opened(url: string, who?: Person): Promise<Probe> {
    const probe = connect(url, who)
    await probe.opened
    return probe
  }
  const send = (probe: Probe, value: unknown): void => {
    probe.socket.send(JSON.stringify(value))
  }
  async function messages(probe: Probe, count: number): Promise<string[]> {
    await until(
      `${count} messages (have ${probe.texts.length})`,
      () => probe.texts.length >= count
    )
    return probe.texts
  }
  const changes = (probe: Probe): number =>
    probe.texts.filter(text => text === '{"type":"changed"}').length

  async function newGame(startAt = new Date(clock)): Promise<string> {
    return await addGame(db, {
      homeTeamId: teams.home.id,
      awayTeamId: teams.away.id,
      startAt
    })
  }

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
  const body = (change: SaveChange): unknown => ({
    ...change,
    mode: 'live',
    source: { system: 'teamstation' }
  })
  /** Where a session writes: through a worker's play post, as the app does. */
  const overHttp = (worker: Worker): EventStore => ({
    load,
    save: async (gameId, change) => {
      const answer = await fetch(`${worker.base}/games/${gameId}/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runner.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body(change))
      })
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`)
      return await load(gameId)
    }
  })
  const direct: EventStore = {
    load,
    save: async (gameId, change) => {
      await postGamePlays(db, gameId, asPostEventsBody(body(change)))
      return await load(gameId)
    }
  }

  /** A scorer on the test's clock, posting each action as it is taken. */
  async function scorer(
    gameId: string,
    store: EventStore
  ): Promise<(action: ScoringAction) => Promise<void>> {
    const session = await ScoringSession.open(
      store,
      gameId,
      { gamePk: gameId, teams, setup },
      {
        now: () => new Date(clock),
        setTimer: () => null,
        clearTimer: () => undefined
      }
    )
    return async action => {
      expect(
        session.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
      await session.flush()
    }
  }

  async function timelineOf(
    worker: Worker,
    gameId: string,
    query = '',
    who: Person | null = runner
  ): Promise<Response> {
    return await fetch(
      `${worker.base}/games/${gameId}/scoreboard-timeline${query}`,
      {
        headers: who == null ? {} : { authorization: `Bearer ${who.token}` }
      }
    )
  }
  async function stepsOf(worker: Worker, gameId: string): Promise<BoardStep[]> {
    const answer = await timelineOf(worker, gameId)
    expect(answer.status).equals(200)
    return ((await answer.json()) as { steps: BoardStep[] }).steps
  }

  /** The board the record's names and the game's scoring alone draw. */
  const boardOf = (
    state: ReturnType<typeof scoreboardOfGame>
  ): ScoreboardState =>
    composeScoreboard({
      baseline: {
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        homeScore: null,
        awayScore: null
      },
      game: { state, receivedAt: 0 }
    }).final

  /** Consecutive equal boards as one. */
  function collapsed(boards: ScoreboardState[]): ScoreboardState[] {
    return boards.filter(
      (board, i) =>
        i === 0 || JSON.stringify(board) !== JSON.stringify(boards[i - 1])
    )
  }

  before(async function () {
    await requireRedis()
    ;({ db, drop } = await scratchDatabase('board_timeline'))
    prefix = testPrefix()
    teams = {
      home: {
        id: await addTeam(db, 'Pioneers'),
        name: 'Pioneers',
        logoUrl: null
      },
      away: {
        id: await addTeam(db, 'Visitors'),
        name: 'Visitors',
        logoUrl: null
      }
    }
    const held = new Set<number>()
    const made = Array.from({ length: 19 }, () => {
      const one = mintUserId(id => held.has(id))
      held.add(one.userId)
      return one
    })
    const created = new Date()
    await db
      .insertInto('users')
      .values(
        made.map((one, i) => ({
          id: one.userId,
          legacyId: one.legacyId,
          display_name: `Player ${i + 1}`,
          created_at: created,
          updated_at: created
        }))
      )
      .execute()
    setup = newSetup(teams, {
      away: made
        .slice(0, 9)
        .map((one, i) => ({ userId: one.userId, shortName: `Away ${i + 1}` })),
      home: made
        .slice(9)
        .map((one, i) => ({ userId: one.userId, shortName: `Home ${i + 1}` }))
    })
    // Ten at home: nine in the order and the field, and one on the bench.
    const homeSide = setup.sides.home
    homeSide.battingOrder = homeSide.battingOrder.slice(0, 9)
    bench = homeSide.players[9]
    secondBaseman = homeSide.defense['2B'] ?? 0
    runner = await addPerson(db, 'runner', { owns: teams.home.id })
    stranger = await addPerson(db, 'stranger')
  })

  afterEach(async function () {
    clock = Date.now()
    logged.splice(0)
    for (const probe of probes.splice(0)) probe.socket.terminate()
    for (const worker of workers.splice(0)) await worker.close()
  })

  after(async function () {
    await dropPrefix('ts-test')
    await drop?.()
  })

  describe('replaying the scoring (U11)', function () {
    it('steps once per action that changes the board, at its time', async function () {
      const gameId = await newGame()
      // A substitution in the field changes nothing on the board.
      const actions: ScoringAction[] = [
        { type: 'pitch', call: 'B' },
        {
          type: 'lineup',
          kind: 'substitute',
          side: 'home',
          player: bench,
          replaces: secondBaseman
        },
        ...situationActions().slice(0, 10)
      ]
      const score = await scorer(gameId, direct)
      const times: number[] = []
      for (const action of actions) {
        clock += 1000
        times.push(clock)
        await score(action)
      }

      let state = freshGame(gameId, teams, setup)
      const expected: BoardStep[] = []
      actions.forEach((action, i) => {
        state = applyAction(state, action).state
        const board = boardOf(scoreboardOfGame(state))
        if (JSON.stringify(expected.at(-1)?.state) !== JSON.stringify(board))
          expected.push({ at: times[i], state: board })
      })
      const timeline = await computeBoardTimeline(db, gameId)
      expect(timeline?.steps).deep.equals(expected)
      expect(expected.length).equals(actions.length - 1)
      expect(timeline?.version).equals(await timelineVersion(db, gameId))
    })

    it("puts a play's actions at its end, and the at-bat in progress at its start, without action times", async function () {
      const gameId = await newGame()
      const actions = situationActions().slice(0, 8)
      const score = await scorer(gameId, direct)
      for (const action of actions) {
        clock += 1000
        await score(action)
      }
      await sql`update events set gumbo = gumbo #- '{teamStation,actionTimes}' where "gameId" = ${gameId}`.execute(
        db
      )
      await sql`update games set "currentPlay" = "currentPlay" #- '{teamStation,actionTimes}' where id = ${gameId}`.execute(
        db
      )
      // Each action at its play's end, or the at-bat in progress's start.
      const plays = await db
        .selectFrom('events')
        .select(['endTime', 'gumbo'])
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex')
        .execute()
      const { currentPlay } = await load(gameId)
      const played = plays.map(row => ({
        at: new Date(row.endTime!).getTime(),
        count: (row.gumbo as { teamStation: { actions: unknown[] } })
          .teamStation.actions.length
      }))
      const current = currentPlay as unknown as {
        about: { startTime: string }
        teamStation: { actions: unknown[]; actionTimes?: unknown }
      }
      expect(current.teamStation.actionTimes).equals(undefined)
      played.push({
        at: Date.parse(current.about.startTime),
        count: current.teamStation.actions.length
      })
      expect(played.length).greaterThan(2)
      const times = played.flatMap(play =>
        Array.from({ length: play.count }, () => play.at)
      )
      expect(times).length(actions.length)

      // At each time, the board after the last action at it.
      let state = freshGame(gameId, teams, setup)
      const expected: BoardStep[] = []
      actions.forEach((action, i) => {
        state = applyAction(state, action).state
        if (times[i + 1] === times[i]) return
        const board = boardOf(scoreboardOfGame(state))
        if (JSON.stringify(expected.at(-1)?.state) !== JSON.stringify(board))
          expected.push({ at: times[i], state: board })
      })
      expect((await computeBoardTimeline(db, gameId))?.steps).deep.equals(
        expected
      )

      // Nothing posted with a time at all: the game's start.
      const untimed = await newGame(new Date(clock - HOUR))
      const scoreUntimed = await scorer(untimed, direct)
      await scoreUntimed({ type: 'pitch', call: 'B' })
      await sql`update games set "currentPlay" = jsonb_set("currentPlay" #- '{teamStation,actionTimes}', '{about,startTime}', 'null') where id = ${untimed}`.execute(
        db
      )
      const lone = (await computeBoardTimeline(db, untimed))?.steps
      expect(lone?.map(step => step.at)).deep.equals([clock - HOUR])
      expect(lone?.[0].state).includes({ balls: 1 })
    })

    it('has no steps for a game with nothing on its board, and none for no game', async function () {
      const gameId = await newGame()
      expect(await computeBoardTimeline(db, gameId)).deep.equals({
        version: await timelineVersion(db, gameId),
        steps: []
      })
      expect(await computeBoardTimeline(db, 'gam_nothere')).equals(undefined)
    })

    it('stops at an action that no longer applies, and says so', async function () {
      const gameId = await newGame()
      const score = await scorer(gameId, direct)
      for (const action of situationActions().slice(0, 5)) {
        clock += 1000
        await score(action)
      }
      // The first play's ball in play, read as strike three before any
      // strike: nothing from there on fits.
      await sql`update events set gumbo = jsonb_set(gumbo, '{teamStation,actions,0}', '{"type":"result","eventType":"strikeout"}') where "gameId" = ${gameId} and "atBatIndex" = 0`.execute(
        db
      )
      const steps = (await computeBoardTimeline(db, gameId, log))?.steps ?? []
      expect(steps.length).greaterThan(0)
      expect(logged.join('\n')).includes(`game ${gameId} replays only to`)
    })
  })

  describe('composing the board (U12–U14)', function () {
    it('steps through exactly the boards the live viewer was sent', async function () {
      const one = await startWorker()
      const two = await startWorker()
      const gameId = await newGame()
      const viewer = await opened(`${one.ws}/${gameId}/socket`)
      await messages(viewer, 1)
      const publisher = await opened(`${one.ws}/${gameId}/publish`, runner)
      const dashboard = await opened(`${two.ws}/${gameId}/dashboard`, runner)
      await messages(dashboard, 1)
      const score = await scorer(gameId, overHttp(two))
      const at: Record<string, number> = {}
      let expected = 1
      /** One write, at its own moment, and the viewer's board after it. */
      async function step(
        name: string,
        write: () => Promise<void> | void
      ): Promise<void> {
        clock += 1000
        at[name] = clock
        const writing = write()
        await messages(viewer, ++expected)
        await writing
        await until(`${name} logged`, async () => {
          const rows = await db
            .selectFrom('scoreboard_log')
            .select('version')
            .where('game_id', '=', gameId)
            .execute()
          return rows.length >= loggedRows[name]
        })
      }
      const loggedRows: Record<string, number> = {}
      const counted = (name: string, rows: number): string => {
        loggedRows[name] = rows
        return name
      }
      const countOn = {
        ...NO_OVERRIDES,
        overrideCountEnabled: true,
        overrideCount: { balls: 0, strikes: 2, outs: 2 }
      }

      await step(counted('ball', 0), async () => {
        await score({ type: 'pitch', call: 'B' })
      })
      await step(counted('publisherCount', 1), () => {
        send(publisher, { balls: 3, strikes: 2 })
      })
      await step(counted('publisherSpeed', 2), () => {
        send(publisher, { pitchSpeed: 61 })
      })
      await step(counted('publisherRepeat', 3), () => {
        send(publisher, { balls: 3, strikes: 2 })
      })
      await step(counted('substitution', 3), async () => {
        await score({
          type: 'lineup',
          kind: 'substitute',
          side: 'home',
          player: bench,
          replaces: secondBaseman
        })
      })
      await step(counted('countOn', 4), () => {
        send(dashboard, { type: 'overrides', data: countOn })
      })
      await step(counted('countOff', 5), () => {
        send(dashboard, {
          type: 'overrides',
          data: { ...countOn, overrideCountEnabled: false }
        })
      })
      await step(counted('reset', 6), () => {
        send(dashboard, { type: 'reset' })
      })
      await step(counted('strike', 6), async () => {
        await score({ type: 'pitch', call: 'S' })
      })

      const sent = viewer.texts
        .slice(1)
        .map(text => JSON.parse(text) as ScoreboardState)
      const steps = await stepsOf(one, gameId)
      expect(steps.map(s => s.state)).deep.equals(collapsed(sent))

      // Each step is at the write that made it; writes that changed nothing
      // drawn (the repeated packet, the substitution after it) make none.
      const stepAt = (name: string): ScoreboardState | undefined =>
        steps.find(s => s.at === at[name])?.state
      expect(steps.map(s => s.at)).deep.equals(
        [
          'ball',
          'publisherCount',
          'publisherSpeed',
          'substitution',
          'countOn',
          'countOff',
          'reset',
          'strike'
        ].map(name => at[name])
      )
      expect(stepAt('ball')).includes({ balls: 1, strikes: 0 })
      expect(stepAt('publisherCount')).includes({ balls: 3, strikes: 2 })
      expect(stepAt('publisherSpeed')).includes({ balls: 3, pitchSpeed: 61 })
      // U13: a scoring action that changes nothing on its own still makes the
      // game the newer source, so its count is back.
      expect(stepAt('substitution')).includes({
        balls: 1,
        strikes: 0,
        pitchSpeed: 61
      })
      // U14: the override shows only while it is on, and a reset drops the
      // overrides and the publisher's speed.
      expect(stepAt('countOn')).includes({ balls: 0, strikes: 2, outs: 2 })
      expect(stepAt('countOff')).includes({ balls: 1, strikes: 0, outs: 0 })
      expect(stepAt('reset')).includes({ balls: 1, pitchSpeed: 0 })
      expect(stepAt('strike')).includes({ balls: 1, strikes: 1 })

      // The last step is what the live board shows now.
      const live = await fetch(`${one.base}/scoreboard/${gameId}`)
      expect(steps.at(-1)?.state).deep.equals(
        ((await live.json()) as { state: ScoreboardState }).state
      )
    })

    it('makes the publisher newer only from its row, and the game again from its next action', async function () {
      const gameId = await newGame()
      const score = await scorer(gameId, direct)
      clock += 1000
      const scored = clock
      await score({ type: 'pitch', call: 'B' })
      const publisher = {
        state: { balls: 2, strikes: 2 },
        receivedAt: clock + 1000
      }
      await db
        .insertInto('scoreboard_log')
        .values({
          game_id: gameId,
          version: 1,
          at: new Date(clock + 1000),
          cause: 'publisher',
          actor_id: null,
          publisher: JSON.stringify(publisher),
          overrides: JSON.stringify(NO_OVERRIDES)
        })
        .execute()
      clock += 2000
      await score({ type: 'pitch', call: 'C' })
      const steps = (await computeBoardTimeline(db, gameId))?.steps ?? []
      expect(steps.map(step => step.at)).deep.equals([
        scored,
        scored + 1000,
        clock
      ])
      expect(
        steps.map(step => [step.state.balls, step.state.strikes])
      ).deep.equals([
        [1, 0],
        [2, 2],
        [1, 1]
      ])
    })
  })

  describe('the score before the game is scored (U15)', function () {
    it("shows each ended play's score from its end, and never the final score early", async function () {
      const gameId = await newGame()
      const base = clock
      const iso = (ms: number): string => new Date(ms).toISOString()
      const play = (
        index: number,
        away: number | null,
        home: number | null,
        endMs: number | null
      ): unknown => ({
        about: {
          atBatIndex: index,
          inning: 1,
          halfInning: index < 2 ? 'top' : 'bottom',
          startTime: endMs == null ? null : iso(endMs - 500),
          endTime: endMs == null ? null : iso(endMs)
        },
        count: { outs: 1 },
        result: {
          eventType: 'single',
          awayScore: away,
          homeScore: home,
          description: 'Single'
        }
      })
      await postGamePlays(
        db,
        gameId,
        asPostEventsBody({
          plays: [
            play(0, 1, 0, base + 10_000),
            play(1, null, null, base + 20_000),
            play(2, 1, 2, base + 30_000),
            play(3, 1, 4, null)
          ],
          source: { system: 'external' }
        })
      )
      const game = await db
        .selectFrom('games')
        .select(['status', 'home_score', 'away_score'])
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      expect(game).deep.equals({
        status: 'final',
        home_score: 4,
        away_score: 1
      })

      const steps = (await computeBoardTimeline(db, gameId))?.steps ?? []
      expect(
        steps.map(step => [step.at, step.state.awayScore, step.state.homeScore])
      ).deep.equals([
        [base + 10_000, 1, 0],
        [base + 30_000, 1, 2]
      ])
      expect(steps[0].state).includes({
        homeTeam: 'Pioneers',
        awayTeam: 'Visitors',
        inGame: false
      })
      expect(stepsInWindow(steps, base, base + 5000)).deep.equals([])
    })
  })

  describe('GET /games/:gameId/scoreboard-timeline (U16)', function () {
    it('answers the window and the step in effect at its start', async function () {
      const worker = await startWorker()
      const gameId = await newGame()
      const score = await scorer(gameId, direct)
      const times: number[] = []
      for (const call of ['B', 'B', 'S', 'B'] as const) {
        clock += 1000
        times.push(clock)
        await score({ type: 'pitch', call })
      }
      const all = await stepsOf(worker, gameId)
      expect(all.map(step => step.at)).deep.equals(times)

      const windowed = await timelineOf(
        worker,
        gameId,
        `?from=${times[1] + 500}&to=${times[2] + 500}`
      )
      const answer = (await windowed.json()) as {
        version: string
        steps: BoardStep[]
      }
      expect(answer.version).equals(await timelineVersion(db, gameId))
      expect(answer.steps.map(step => step.at)).deep.equals([
        times[1],
        times[2]
      ])
      const onStep = await timelineOf(worker, gameId, `?from=${times[2]}`)
      expect(
        ((await onStep.json()) as { steps: BoardStep[] }).steps.map(
          step => step.at
        )
      ).deep.equals([times[2], times[3]])
      const before = await timelineOf(worker, gameId, `?to=${times[0] - 1}`)
      expect(
        ((await before.json()) as { steps: BoardStep[] }).steps
      ).deep.equals([])
    })

    it('needs a token, a game and a caller who can see it, and good bounds', async function () {
      const worker = await startWorker()
      const gameId = await newGame()
      expect((await timelineOf(worker, gameId, '', null)).status).equals(401)
      expect((await timelineOf(worker, 'gam_nothere')).status).equals(404)
      const unseen = await timelineOf(worker, gameId, '', stranger)
      expect(unseen.status).equals(403)
      expect(((await unseen.json()) as { code: string }).code).equals(
        'membersOnly'
      )
      for (const query of ['?from=soon', '?to=-1', '?from=20&to=10']) {
        expect((await timelineOf(worker, gameId, query)).status, query).equals(
          400
        )
      }
    })

    it('is described in the API document, with the socket parameter', function () {
      const paths = openApiDocument('test').paths as Record<string, any>
      const route = paths['/games/{gameId}/scoreboard-timeline'].get
      expect(route.parameters.map((p: { name: string }) => p.name)).deep.equals(
        ['gameId', 'from', 'to']
      )
      expect(Object.keys(route.responses)).includes.members([
        '401',
        '403',
        '404'
      ])
      const socket = paths['/scoreboard/{gameId}/socket'].get
      expect(socket.parameters.map((p: { name: string }) => p.name)).includes(
        'timeline'
      )
      expect(socket.description).includes("{ type: 'changed' }")
    })
  })

  describe('change notices and the cache (U17)', function () {
    it('tells a timeline viewer on another worker of a scoring and a dashboard write, after they commit', async function () {
      const one = await startWorker()
      const two = await startWorker()
      const gameId = await newGame()
      const listener = await opened(`${one.ws}/${gameId}/socket?timeline=1`)
      const plain = await opened(`${one.ws}/${gameId}/socket`)
      await messages(plain, 1)
      const score = await scorer(gameId, overHttp(two))

      // Each notice is answered at once with a fetch, which already holds
      // the write: the notice follows the commit.
      const seen: BoardStep[][] = []
      listener.socket.on('message', () => {
        stepsOf(one, gameId).then(
          steps => seen.push(steps),
          () => undefined
        )
      })

      clock += 1000
      await score({ type: 'pitch', call: 'B' })
      await until('the scoring notice', () => seen.length >= 1)
      expect(seen[0].at(-1)?.state).includes({ balls: 1 })

      const dashboard = await opened(`${two.ws}/${gameId}/dashboard`, runner)
      clock += 1000
      send(dashboard, {
        type: 'overrides',
        data: {
          ...NO_OVERRIDES,
          overrideInningEnabled: true,
          overrideInning: { inning: 7, half: 'bottom' }
        }
      })
      await until('the dashboard notice', () => seen.length >= 2)
      expect(seen[1].at(-1)).deep.include({ at: clock })
      expect(seen[1].at(-1)?.state).includes({ inning: 7, half: 'bottom' })
      expect(listener.texts).deep.equals([
        '{"type":"changed"}',
        '{"type":"changed"}'
      ])

      // The plain viewer was sent the bare board after each write, the same
      // bytes as before there were notices, and no notice.
      await messages(plain, 3)
      for (const text of plain.texts) {
        expect(text.startsWith('{"inGame":')).equals(true)
        expect(text).not.includes('changed')
      }
      const live = await fetch(`${one.base}/scoreboard/${gameId}`)
      expect(plain.texts.at(-1)).equals(
        JSON.stringify(((await live.json()) as { state: unknown }).state)
      )
    })

    it('notices a game write on a closed board, and keeps a timeline viewer while the game exists', async function () {
      const one = await startWorker({ checkMs: 100 })
      const two = await startWorker()
      // Three hours past its start with no live board: closed.
      const gameId = await newGame(new Date(clock - 3 * HOUR))
      const refused = connect(`${one.ws}/${gameId}/socket`)
      expect(await refused.closed).equals(4404)
      const listener = await opened(`${one.ws}/${gameId}/socket?timeline=1`)

      const score = await scorer(gameId, overHttp(two))
      clock += 1000
      await score({ type: 'pitch', call: 'S' })
      await until('the notice', () => changes(listener) >= 1)
      expect(await two.store.readScoreboard(gameId)).equals(undefined)
      expect((await stepsOf(one, gameId)).at(-1)?.state).includes({
        strikes: 1
      })

      // Several checks later, it is still open.
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(listener.socket.readyState).equals(WebSocket.OPEN)

      // A game that goes away takes its timeline viewers with it.
      const doomed = await newGame()
      const orphan = await opened(`${one.ws}/${doomed}/socket?timeline=1`)
      await db.deleteFrom('games').where('id', '=', doomed).execute()
      expect(await orphan.closed).equals(4404)
      // And one for no game at all is never admitted.
      expect(
        await connect(`${one.ws}/gam_nothere/socket?timeline=1`).closed
      ).equals(4404)
    })

    it('notices a game write that changes no live board', async function () {
      const worker = await startWorker()
      const gameId = await newGame()
      const listener = await opened(`${worker.ws}/${gameId}/socket?timeline=1`)
      // Another service's plays: nothing TeamStation scored, so nothing is
      // written to the live board, but the score baseline has moved.
      const answer = await fetch(`${worker.base}/games/${gameId}/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runner.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          plays: [
            {
              about: {
                atBatIndex: 0,
                inning: 1,
                halfInning: 'top',
                startTime: new Date(clock).toISOString(),
                endTime: new Date(clock + 1000).toISOString()
              },
              count: { outs: 0 },
              result: {
                eventType: 'home_run',
                awayScore: 1,
                homeScore: 0,
                description: 'Home run'
              }
            }
          ]
        })
      })
      expect(answer.status).equals(200)
      await until('the notice', () => changes(listener) >= 1)
      expect(await worker.store.readScoreboard(gameId)).equals(undefined)
      expect((await stepsOf(worker, gameId)).at(-1)?.state).includes({
        awayScore: 1
      })
    })

    it('keeps a timeline under its version, and builds it again when the plays or the log move', async function () {
      const worker = await startWorker()
      const cache = makeBoardTimelineCache(2)
      const gameId = await newGame()
      const score = await scorer(gameId, overHttp(worker))
      clock += 1000
      await score({ type: 'pitch', call: 'B' })
      const first = await cache.get(db, gameId)
      expect(await cache.get(db, gameId)).equals(first)

      // A scoring post moves the game's updated_at.
      clock += 1000
      await score({ type: 'pitch', call: 'B' })
      const scored = await cache.get(db, gameId)
      expect(scored).not.equals(first)
      expect(scored?.version).not.equals(first?.version)
      expect(scored?.steps.at(-1)?.state).includes({ balls: 2 })

      // A log row moves its other half.
      const publisher = await opened(`${worker.ws}/${gameId}/publish`, runner)
      clock += 1000
      send(publisher, { outs: 2 })
      await until('the row', async () => {
        const version = await timelineVersion(db, gameId)
        return !(version ?? '').endsWith(':0')
      })
      const logged = await cache.get(db, gameId)
      expect(logged).not.equals(scored)
      expect(logged?.version.split(':')[0]).equals(
        scored?.version.split(':')[0]
      )
      expect(logged?.steps.at(-1)?.state).includes({ outs: 2 })

      // The live board's key expiring changes nothing the timeline reads.
      await worker.store.readScoreboard(gameId)
      const client = await connectedClient()
      await client.del(worker.store.keyOf(gameId))
      await client.close()
      expect(await cache.get(db, gameId)).equals(logged)
      expect((await stepsOf(worker, gameId)).at(-1)?.state).includes({
        outs: 2
      })

      // Only the most recent games are kept.
      const others = [await newGame(), await newGame()]
      for (const other of others) await cache.get(db, other)
      expect(await cache.get(db, gameId)).not.equals(logged)
      expect(await cache.get(db, 'gam_nothere')).equals(undefined)
    })
  })

  describe('stepsInWindow', function () {
    const board: ScoreboardState = { ...SAMPLE_SCOREBOARD }
    const steps = [10, 20, 30].map(at => ({ at, state: board }))
    const ats = (from?: number, to?: number): number[] =>
      stepsInWindow(steps, from, to).map(step => step.at)

    it('keeps the step in effect at the start, and nothing past the end', function () {
      expect(ats()).deep.equals([10, 20, 30])
      expect(ats(5)).deep.equals([10, 20, 30])
      expect(ats(10)).deep.equals([10, 20, 30])
      expect(ats(15)).deep.equals([10, 20, 30])
      expect(ats(20, 25)).deep.equals([20])
      expect(ats(25, 30)).deep.equals([20, 30])
      expect(ats(35)).deep.equals([30])
      expect(ats(undefined, 9)).deep.equals([])
      expect(stepsInWindow([], 5, 10)).deep.equals([])
    })
  })
})
