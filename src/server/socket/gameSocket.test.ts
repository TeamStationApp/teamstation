import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'
import WebSocket from 'ws'

import type { GameSocketReply } from '../../common/gameSocket'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import type { ScoringAction } from '../../common/scoring/actions'
import { newSetup } from '../../common/scoring/lineup'
import { type EventStore, ScoringSession } from '../../common/scoring/session'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import { type Database, makeDatabase } from '../db/database'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { eventRoutes } from '../routes/events'
import {
  attachGameSocket,
  type GameSocketHandle,
  MAX_SUBSCRIPTIONS
} from './gameSocket'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_game_socket_${Date.now()}_${process.pid}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const SCORER = 'tok_socket_scorer_0000000000000000'
const VIEWER = 'tok_socket_viewer_0000000000000000'
const OTHER = 'tok_socket_other_00000000000000000'
const FADING = 'tok_socket_fading_0000000000000000'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A `ws` client that keeps every frame it is sent. */
interface Listener {
  ws: WebSocket
  frames: GameSocketReply[]
  closed: Promise<number>
  send: (frame: unknown) => void
  /** Resolves with the first frame from `from` on that matches. */
  next: (
    match: (frame: GameSocketReply) => boolean,
    from?: number
  ) => Promise<GameSocketReply>
}

/** U14: the server end, on a real HTTP server and a scratch database. */
describe('the game socket (U14)', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let socket: GameSocketHandle | undefined
  let base = ''
  let socketUrl = ''
  let now = 1_000_000
  const signals = new EventEmitter()
  /** Games whose visibility check throws, as a database out of connections. */
  const failing = new Set<string>()
  const logged: string[] = []
  const listeners: Listener[] = []

  const taken = new Set<number>()
  const mint = (): { userId: number; legacyId: string } => {
    const minted = mintUserId(id => taken.has(id))
    taken.add(minted.userId)
    return minted
  }
  const scorer = mint()
  const viewer = mint()
  const other = mint()
  const fading = mint()
  const awayPlayers = Array.from({ length: 10 }, mint)
  const homePlayers = Array.from({ length: 9 }, mint)
  const awayTeam = makeId('team')
  const homeTeam = makeId('team')
  const strangers = makeId('team')
  const TEAMS = {
    away: { id: awayTeam, name: 'Away' },
    home: { id: homeTeam, name: 'Home' }
  }
  const rosterOf = (
    users: Array<{ userId: number }>
  ): Array<{
    userId: string
    gumboId: number
    shortName: string
    jersey: string
  }> =>
    users.map((user, i) => ({
      userId: userIdOfGumbo(user.userId),
      gumboId: user.userId,
      shortName: `P${i + 1}`,
      jersey: String(i + 1)
    }))
  const setup = newSetup(TEAMS, {
    away: rosterOf(awayPlayers),
    home: rosterOf(homePlayers)
  })
  setup.sides.away.battingOrder = setup.sides.away.battingOrder.slice(0, 9)
  const scored = makeId('game')
  const hidden = makeId('game')
  // One more than the cap, so a socket can ask for two past it at once.
  const many = Array.from({ length: MAX_SUBSCRIPTIONS + 1 }, () =>
    makeId('game')
  )

  async function listen(token?: string): Promise<Listener> {
    const ws = new WebSocket(
      socketUrl,
      token == null ? {} : { headers: { authorization: `Bearer ${token}` } }
    )
    const frames: GameSocketReply[] = []
    const waiting: Array<() => void> = []
    ws.on('message', data => {
      frames.push(
        JSON.parse((data as Buffer).toString('utf8')) as GameSocketReply
      )
      for (const wake of waiting.splice(0)) wake()
    })
    const closed = new Promise<number>(resolve => {
      ws.on('close', code => {
        resolve(code)
      })
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })
    const listener: Listener = {
      ws,
      frames,
      closed,
      send: frame => {
        ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
      },
      next: async (match, from = 0) => {
        const deadline = Date.now() + 3000
        for (;;) {
          const found = frames.slice(from).find(match)
          if (found != null) return found
          if (Date.now() > deadline)
            throw new Error(`No such frame in ${JSON.stringify(frames)}`)
          await new Promise<void>(resolve => {
            waiting.push(resolve)
            setTimeout(resolve, 50)
          })
        }
      }
    }
    listeners.push(listener)
    return listener
  }

  /** The upgrade's HTTP status, for one that is refused. */
  async function refusedWith(
    url: string,
    headers: Record<string, string> = {}
  ): Promise<number> {
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers })
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0)
        ws.terminate()
      })
      ws.on('open', () => {
        reject(new Error('The upgrade was accepted'))
      })
      ws.on('error', () => undefined)
    })
  }

  async function subscribed(
    listener: Listener,
    gameId: string,
    id = makeId('game')
  ): Promise<GameSocketReply> {
    const from = listener.frames.length
    listener.send({ type: 'subscribe', gameId, id })
    return await listener.next(frame => 'id' in frame && frame.id === id, from)
  }

  /** The events route, as the scoring screen's store, posting as the scorer. */
  const store: EventStore = {
    load: async () => {
      const response = await fetch(`${base}/games/${scored}/events`, {
        headers: { authorization: `Bearer ${SCORER}` }
      })
      const read = (await response.json()) as {
        plays: Array<{ gumbo: GumboPlay }>
        currentPlay: CurrentPlay | null
      }
      return {
        plays: read.plays.map(row => row.gumbo),
        currentPlay: read.currentPlay
      }
    },
    save: async (_gameId, change) => {
      const response = await fetch(`${base}/games/${scored}/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SCORER}`
        },
        body: JSON.stringify({
          mode: 'live',
          source: { system: 'teamstation' },
          plays: change.plays,
          remove: change.remove,
          ...(change.currentPlay === undefined
            ? {}
            : { currentPlay: change.currentPlay })
        })
      })
      const answer = (await response.json()) as {
        plays: Array<{ gumbo: GumboPlay }>
        currentPlay: CurrentPlay | null
      }
      expect(response.status, JSON.stringify(answer)).equals(200)
      return {
        plays: answer.plays.map(row => row.gumbo),
        currentPlay: answer.currentPlay
      }
    }
  }
  let session: ScoringSession | undefined
  async function apply(...actions: ScoringAction[]): Promise<void> {
    for (const action of actions)
      expect(
        session!.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
    await session!.flush()
    expect(session!.problem).equals(null)
  }
  const strike: ScoringAction = { type: 'pitch', call: 'C' }
  const ball: ScoringAction = { type: 'pitch', call: 'B' }

  /** The kinds of change a listener heard for the scored game from `from`. */
  const kindsHeard = (listener: Listener, from: number): string[] =>
    listener.frames
      .slice(from)
      .filter(frame => frame.type === 'change' && frame.gameId === scored)
      .map(frame => (frame.type === 'change' ? frame.kind : ''))

  /** Waits until a post's `plays` and `game` have arrived, and a little more. */
  async function settled(listener: Listener, from: number): Promise<string[]> {
    await listener.next(
      frame => frame.type === 'change' && frame.kind === 'game',
      from
    )
    await listener.next(
      frame => frame.type === 'change' && frame.kind === 'plays',
      from
    )
    await wait(150)
    return kindsHeard(listener, from).sort()
  }

  /**
   * Waits until nothing is connected to the scratch database. A pool's end()
   * resolves before its clients have hung up, and a drop `with (force)` that
   * terminates one of them raises an error on a pool nobody listens to.
   */
  async function hungUp(admin: Pool): Promise<void> {
    const deadline = Date.now() + 10_000
    for (;;) {
      const { rows } = await admin.query<{ pid: number; query: string }>(
        'select pid, query from pg_stat_activity where datname = $1',
        [scratchName]
      )
      if (rows.length === 0) return
      if (Date.now() > deadline)
        throw new Error(
          `Still connected to ${scratchName}: ${JSON.stringify(rows)}`
        )
      await wait(20)
    }
  }

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const at = new Date()
    await insertFixtureUsers(
      db,
      [scorer, viewer, other, fading, ...awayPlayers, ...homePlayers].map(
        user => ({
          id: user.userId,
          legacyId: user.legacyId,
          display_name: `User ${user.userId}`,
          is_admin: user === scorer,
          created_at: at,
          updated_at: at
        })
      )
    )
    await db
      .insertInto('auth_sessions')
      .values(
        (
          [
            [scorer, SCORER],
            [viewer, VIEWER],
            [other, OTHER],
            [fading, FADING]
          ] as const
        ).map(([user, token]) => ({
          id: `ses_${token}`,
          user_id: userIdOfGumbo(user.userId),
          token_hash: hashToken(token),
          created_at: at,
          expires_at: new Date(at.getTime() + 3_600_000)
        }))
      )
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: homeTeam, name: 'Home', kind: 'full' },
        { id: awayTeam, name: 'Away', kind: 'full' },
        { id: strangers, name: 'Strangers', kind: 'full' }
      ])
      .execute()
    await db
      .insertInto('games')
      .values([
        {
          id: scored,
          home_team_id: homeTeam,
          away_team_id: awayTeam,
          start_at: at
        },
        {
          id: hidden,
          home_team_id: strangers,
          away_team_id: strangers,
          start_at: at
        },
        ...many.map(id => ({
          id,
          home_team_id: homeTeam,
          away_team_id: strangers,
          start_at: at
        }))
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values(
        [viewer, other, fading].map(user => ({
          id: makeId('membership'),
          user_id: userIdOfGumbo(user.userId),
          team_id: homeTeam,
          role: 'member'
        }))
      )
      .execute()

    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', eventRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    base = `http://127.0.0.1:${port}/api/v1`
    socketUrl = `ws://127.0.0.1:${port}/socket`
    socket = attachGameSocket(server, db, scratchUrl, {
      pingMs: 100,
      recheckMs: 60_000,
      clock: () => now,
      stopSignals: signals,
      fanout: { coalesceMs: 20, retryMs: 50, log: () => undefined },
      log: message => {
        logged.push(message)
      },
      checkGame: async (gameId, check) => {
        if (failing.has(gameId))
          throw new Error('sorry, too many clients already')
        return await check()
      }
    })
    await socket.fanout.listening
    session = await ScoringSession.open(store, scored, {
      gamePk: scored,
      teams: TEAMS,
      setup
    })
  })

  after(async function () {
    for (const listener of listeners) listener.ws.terminate()
    // The socket's LISTEN connection, awaited until it has hung up.
    await socket?.close()
    if (server != null) {
      const closing = server
      await new Promise<void>(resolve => {
        closing.close(() => {
          resolve()
        })
        closing.closeAllConnections()
      })
    }
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await hungUp(adminPool)
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  describe('the upgrade', function () {
    it('is refused with 401 with no token, or a bad one', async function () {
      expect(await refusedWith(socketUrl)).equals(401)
      expect(
        await refusedWith(socketUrl, { authorization: 'Bearer tok_nobody' })
      ).equals(401)
      expect(
        await refusedWith(socketUrl, { cookie: 'ts_session=tok_nobody' })
      ).equals(401)
    })

    it('is refused with 404 anywhere but /socket', async function () {
      expect(
        await refusedWith(socketUrl.replace('/socket', '/api/v1/socket'), {
          authorization: `Bearer ${VIEWER}`
        })
      ).equals(404)
    })

    it('declines a scoreboard path without writing a response', function () {
      const raw = new PassThrough()
      const req = {
        url: '/api/v1/scoreboard/gam_x/dashboard',
        headers: {}
      } as unknown as IncomingMessage
      expect(socket?.acceptUpgrade(req, raw, Buffer.alloc(0))).equals(false)
      expect(raw.writableEnded).equals(false)
      raw.destroy()
    })

    it('is taken with the session cookie, as a browser sends it', async function () {
      const ws = new WebSocket(socketUrl, {
        headers: { cookie: `ts_session=${VIEWER}` }
      })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      ws.terminate()
    })
  })

  describe('subscribing', function () {
    it('answers subscribed for a game it can see, and notFound for one it cannot', async function () {
      const listener = await listen(VIEWER)
      expect(await subscribed(listener, scored, 'c1')).deep.equals({
        type: 'subscribed',
        gameId: scored,
        id: 'c1'
      })
      expect(await subscribed(listener, hidden, 'c2')).deep.include({
        type: 'error',
        id: 'c2',
        gameId: hidden,
        code: 'notFound'
      })
      expect(await subscribed(listener, 'gam_nosuch', 'c3')).deep.include({
        type: 'error',
        code: 'notFound'
      })
      // Twice is once.
      expect(await subscribed(listener, scored, 'c4')).deep.equals({
        type: 'subscribed',
        gameId: scored,
        id: 'c4'
      })
      expect(socket!.fanout.games()).to.include(scored)
      listener.ws.close()
      expect(await listener.closed).equals(1005)
    })

    it('refuses the twenty-first game with tooMany', async function () {
      const listener = await listen(VIEWER)
      await subscribed(listener, scored)
      for (const gameId of many.slice(0, MAX_SUBSCRIPTIONS - 1))
        expect((await subscribed(listener, gameId)).type).equals('subscribed')
      const refused = await subscribed(listener, many[MAX_SUBSCRIPTIONS - 1])
      expect(refused).deep.include({ type: 'error', code: 'tooMany' })
      // One already held is still answered.
      expect((await subscribed(listener, many[0])).type).equals('subscribed')
      // Many at once cannot pass the limit between them either.
      listener.send({ type: 'unsubscribe', gameId: many[0], id: 'u1' })
      await listener.next(frame => 'id' in frame && frame.id === 'u1')
      const from = listener.frames.length
      listener.send({ type: 'subscribe', gameId: many[0], id: 'r1' })
      listener.send({
        type: 'subscribe',
        gameId: many[MAX_SUBSCRIPTIONS - 1],
        id: 'r2'
      })
      const first = await listener.next(
        frame => 'id' in frame && frame.id === 'r1',
        from
      )
      const second = await listener.next(
        frame => 'id' in frame && frame.id === 'r2',
        from
      )
      // The place goes to the one sent first.
      expect(first.type).equals('subscribed')
      expect(second).deep.include({ type: 'error', code: 'tooMany' })
      listener.ws.terminate()
    })

    it('refuses a burst past the cap in the order it was sent', async function () {
      const listener = await listen(VIEWER)
      const games = [scored, ...many]
      expect(games.length).equals(MAX_SUBSCRIPTIONS + 2)
      games.forEach((gameId, i) => {
        listener.send({ type: 'subscribe', gameId, id: `s${i}` })
      })
      const answers = []
      for (let i = 0; i < games.length; i++)
        answers.push(
          await listener.next(frame => 'id' in frame && frame.id === `s${i}`)
        )
      expect(
        answers.slice(0, MAX_SUBSCRIPTIONS).map(answer => answer.type)
      ).deep.equals(Array(MAX_SUBSCRIPTIONS).fill('subscribed'))
      for (const answer of answers.slice(MAX_SUBSCRIPTIONS))
        expect(answer).deep.include({ type: 'error', code: 'tooMany' })
      listener.ws.terminate()
    })

    it('gives back the place of a game it cannot see', async function () {
      const listener = await listen(VIEWER)
      for (const gameId of many.slice(0, MAX_SUBSCRIPTIONS - 1))
        expect((await subscribed(listener, gameId)).type).equals('subscribed')
      // The last place, held while the hidden game is checked, then freed.
      expect(await subscribed(listener, hidden)).deep.include({
        code: 'notFound'
      })
      expect((await subscribed(listener, scored)).type).equals('subscribed')
      expect(
        await subscribed(listener, many[MAX_SUBSCRIPTIONS - 1])
      ).deep.include({ code: 'tooMany' })
      listener.ws.terminate()
    })

    it('answers a check that throws with internal, frees its place, and goes on', async function () {
      const listener = await listen(VIEWER)
      for (const gameId of many.slice(0, MAX_SUBSCRIPTIONS - 1))
        expect((await subscribed(listener, gameId)).type).equals('subscribed')
      const from = listener.frames.length
      const before = logged.length
      failing.add(scored)
      try {
        // The last place, held while the check fails, and a request behind it.
        listener.send({ type: 'subscribe', gameId: scored, id: 'x1' })
        listener.send({ type: 'unsubscribe', gameId: scored, id: 'x2' })
        await listener.next(frame => 'id' in frame && frame.id === 'x2', from)
      } finally {
        failing.delete(scored)
      }
      expect(listener.frames.slice(from)).deep.equals([
        {
          type: 'error',
          id: 'x1',
          gameId: scored,
          code: 'internal',
          message: 'The server could not subscribe; try again'
        },
        { type: 'unsubscribed', gameId: scored, id: 'x2' }
      ])
      expect(logged.slice(before)).deep.equals([
        `game socket: subscribe ${scored}: Error: sorry, too many clients already`
      ])
      // Its place was given back: the twentieth game is admitted...
      expect(
        (await subscribed(listener, many[MAX_SUBSCRIPTIONS - 1])).type
      ).equals('subscribed')
      expect(await subscribed(listener, scored)).deep.include({
        code: 'tooMany'
      })
      // ...and once there is room, the game that failed subscribes as usual.
      listener.send({
        type: 'unsubscribe',
        gameId: many[MAX_SUBSCRIPTIONS - 1],
        id: 'x3'
      })
      expect((await subscribed(listener, scored)).type).equals('subscribed')
      expect(socket!.fanout.games()).to.include(scored)
      listener.ws.terminate()
    })

    it('answers the same game asked for twice at once alike', async function () {
      const listener = await listen(VIEWER)
      for (const [gameId, prefix] of [
        [scored, 'd'],
        [hidden, 'h']
      ] as const) {
        listener.send({ type: 'subscribe', gameId, id: `${prefix}1` })
        listener.send({ type: 'subscribe', gameId, id: `${prefix}2` })
      }
      const answer = async (id: string): Promise<GameSocketReply> =>
        await listener.next(frame => 'id' in frame && frame.id === id)
      expect((await answer('d1')).type).equals('subscribed')
      expect((await answer('d2')).type).equals('subscribed')
      expect(await answer('h1')).deep.include({ code: 'notFound' })
      expect(await answer('h2')).deep.include({ code: 'notFound' })
      listener.ws.terminate()
    })
  })

  describe('unsubscribing', function () {
    it('undoes a subscribe it follows, even one still being checked', async function () {
      const listener = await listen(VIEWER)
      // Never subscribed to by any other test, so no one else watches it.
      const gameId = many[MAX_SUBSCRIPTIONS]
      listener.send({ type: 'subscribe', gameId, id: 'a1' })
      listener.send({ type: 'unsubscribe', gameId, id: 'a2' })
      await listener.next(frame => 'id' in frame && frame.id === 'a2')
      expect(
        listener.frames.map(frame => ('id' in frame ? frame.id : frame.type))
      ).deep.equals(['a1', 'a2'])
      expect(listener.frames.map(frame => frame.type)).deep.equals([
        'subscribed',
        'unsubscribed'
      ])
      expect(socket!.fanout.games()).not.to.include(gameId)
      // And a subscribe after that is the one that stands.
      listener.send({ type: 'subscribe', gameId, id: 'a3' })
      listener.send({ type: 'unsubscribe', gameId, id: 'a4' })
      listener.send({ type: 'subscribe', gameId, id: 'a5' })
      await listener.next(frame => 'id' in frame && frame.id === 'a5')
      expect(listener.frames.slice(2).map(frame => frame.type)).deep.equals([
        'subscribed',
        'unsubscribed',
        'subscribed'
      ])
      expect(socket!.fanout.games()).to.include(gameId)
      listener.send({ type: 'unsubscribe', gameId, id: 'a6' })
      await listener.next(frame => 'id' in frame && frame.id === 'a6')
      expect(socket!.fanout.games()).not.to.include(gameId)
      listener.ws.terminate()
    })

    it('frees the place of a subscribe it undid', async function () {
      const listener = await listen(VIEWER)
      for (const gameId of many.slice(0, MAX_SUBSCRIPTIONS - 1))
        expect((await subscribed(listener, gameId)).type).equals('subscribed')
      listener.send({ type: 'subscribe', gameId: scored, id: 'f1' })
      listener.send({ type: 'unsubscribe', gameId: scored, id: 'f2' })
      await listener.next(frame => 'id' in frame && frame.id === 'f2')
      expect(
        (await subscribed(listener, many[MAX_SUBSCRIPTIONS - 1])).type
      ).equals('subscribed')
      listener.ws.terminate()
    })
    it('frees a place when the unsubscribe arrives, not when its subscribe is done', async function () {
      // QA's case F: 22 subscribe/unsubscribe pairs to different games, sent
      // in one burst, never hold more than one game in the order sent.
      const listener = await listen(VIEWER)
      const games = [scored, ...many, hidden]
      expect(games.length).greaterThan(MAX_SUBSCRIPTIONS + 1)
      games.forEach((gameId, i) => {
        listener.send({ type: 'subscribe', gameId, id: `p${i}` })
        listener.send({ type: 'unsubscribe', gameId, id: `q${i}` })
      })
      for (let i = 0; i < games.length; i++)
        await listener.next(frame => 'id' in frame && frame.id === `q${i}`)
      const answers = (prefix: string): string[] =>
        games.map(
          (_, i) =>
            listener.frames.find(
              frame => 'id' in frame && frame.id === `${prefix}${i}`
            )!.type
        )
      expect(answers('p')).deep.equals([
        ...Array(games.length - 1).fill('subscribed'),
        'error'
      ])
      expect(answers('q')).deep.equals(Array(games.length).fill('unsubscribed'))
      // Each game's answers still come in the order sent.
      games.forEach((_, i) => {
        const at = (id: string): number =>
          listener.frames.findIndex(frame => 'id' in frame && frame.id === id)
        expect(at(`p${i}`)).lessThan(at(`q${i}`))
      })
      expect(
        listener.frames.some(
          frame => frame.type === 'error' && frame.code === 'tooMany'
        )
      ).equals(false)
      // Nothing is left holding a place: a full burst is admitted after it.
      const from = listener.frames.length
      many.slice(0, MAX_SUBSCRIPTIONS + 1).forEach((gameId, i) => {
        listener.send({ type: 'subscribe', gameId, id: `r${i}` })
      })
      const burst = []
      for (let i = 0; i <= MAX_SUBSCRIPTIONS; i++)
        burst.push(
          await listener.next(
            frame => 'id' in frame && frame.id === `r${i}`,
            from
          )
        )
      expect(
        burst.slice(0, MAX_SUBSCRIPTIONS).map(frame => frame.type)
      ).deep.equals(Array(MAX_SUBSCRIPTIONS).fill('subscribed'))
      expect(burst[MAX_SUBSCRIPTIONS]).deep.include({
        type: 'error',
        code: 'tooMany'
      })
      listener.ws.terminate()
    })
  })

  describe('the protocol', function () {
    it('answers bad JSON, a frame of the wrong shape and a binary frame with malformed', async function () {
      const listener = await listen(VIEWER)
      listener.send('{ not json')
      expect(await listener.next(frame => frame.type === 'error')).deep.include(
        { code: 'malformed' }
      )
      listener.send({ type: 'subscribe', id: 'x1' })
      expect(
        await listener.next(frame => 'id' in frame && frame.id === 'x1')
      ).deep.include({ type: 'error', code: 'malformed' })
      listener.send('null')
      listener.ws.send(Buffer.from('{"type":"ping","id":"b1"}'), {
        binary: true
      })
      await wait(100)
      expect(
        listener.frames.filter(
          frame => frame.type === 'error' && frame.code === 'malformed'
        )
      ).lengthOf(4)
      listener.ws.terminate()
    })

    it('answers ping with pong, and unsubscribe with unsubscribed', async function () {
      const listener = await listen(VIEWER)
      listener.send({ type: 'ping', id: 'p1' })
      expect(await listener.next(frame => frame.type === 'pong')).deep.equals({
        type: 'pong',
        id: 'p1'
      })
      listener.send({ type: 'unsubscribe', gameId: scored, id: 'u1' })
      expect(
        await listener.next(frame => frame.type === 'unsubscribed')
      ).deep.equals({ type: 'unsubscribed', gameId: scored, id: 'u1' })
      listener.ws.terminate()
    })

    it('closes a frame over 4 KB with 1009', async function () {
      const listener = await listen(VIEWER)
      listener.send({ type: 'ping', id: 'x'.repeat(5000) })
      expect(await listener.closed).equals(1009)
    })
  })

  describe('delivery', function () {
    it('delivers plays and game for a post, and lineups only when they change', async function () {
      const listener = await listen(VIEWER)
      const quiet = await listen(OTHER)
      await subscribed(listener, scored)
      await subscribed(quiet, scored)
      quiet.send({ type: 'unsubscribe', gameId: scored, id: 'q1' })
      await quiet.next(frame => frame.type === 'unsubscribed')

      // The first pitch begins the game, and the lineups appear with it.
      let from = listener.frames.length
      await apply(ball)
      expect(await settled(listener, from)).deep.equals([
        'game',
        'lineups',
        'plays'
      ])
      const plays = listener.frames
        .slice(from)
        .find(frame => frame.type === 'change' && frame.kind === 'plays')
      expect(plays?.type === 'change' && plays.data).to.have.keys(
        'plays',
        'currentPlay',
        'digest'
      )

      // Another pitch leaves the lineups alone.
      from = listener.frames.length
      await apply(strike)
      expect(await settled(listener, from)).deep.equals(['game', 'plays'])

      // Strike him out, then pinch-hit for the batter due.
      await apply(strike, strike, { type: 'gameFlow', kind: 'closePlay' })
      await wait(150)
      from = listener.frames.length
      await apply({
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: awayPlayers[9].userId,
        replaces: awayPlayers[1].userId
      })
      expect(await settled(listener, from)).deep.equals([
        'game',
        'lineups',
        'plays'
      ])
      const lineups = listener.frames
        .slice(from)
        .find(frame => frame.type === 'change' && frame.kind === 'lineups')
      const away =
        lineups?.type === 'change' && lineups.kind === 'lineups'
          ? lineups.data.away
          : undefined
      expect(away?.teamId).equals(awayTeam)
      expect(JSON.stringify(away?.current)).to.include(
        String(awayPlayers[9].userId)
      )

      // Undone, it is announced once more.
      from = listener.frames.length
      session!.undo()
      await session!.flush()
      expect(await settled(listener, from)).deep.equals([
        'game',
        'lineups',
        'plays'
      ])

      // And a pitch after it is not.
      from = listener.frames.length
      await apply(ball)
      expect(await settled(listener, from)).deep.equals(['game', 'plays'])

      expect(kindsHeard(quiet, 0)).deep.equals([])
      listener.ws.terminate()
      quiet.ws.terminate()
    })

    it('stops private delivery immediately after permission loss, even with a cached subscription scope', async function () {
      const listener = await listen(FADING)
      await subscribed(listener, scored)
      const control = await listen(SCORER)
      await subscribed(control, scored)
      await db!
        .deleteFrom('memberships')
        .where('user_id', '=', userIdOfGumbo(fading.userId))
        .execute()
      // The earlier subscription cache cannot authorize a later private frame.
      let from = listener.frames.length
      let controlFrom = control.frames.length
      await apply(ball)
      await settled(control, controlFrom)
      expect(kindsHeard(listener, from)).deep.equals([])
      now += 60_000
      from = listener.frames.length
      controlFrom = control.frames.length
      await apply(strike)
      await settled(control, controlFrom)
      expect(kindsHeard(listener, from)).deep.equals([])
      listener.ws.terminate()
      control.ws.terminate()
    })
  })

  describe('keeping alive', function () {
    it('closes a socket that misses two pings, and keeps one that answers', async function () {
      const answers = await listen(VIEWER)
      const silent = new WebSocket(socketUrl, {
        headers: { authorization: `Bearer ${VIEWER}` },
        autoPong: false
      })
      const closed = new Promise<number>(resolve => {
        silent.on('close', resolve)
      })
      await new Promise(resolve => silent.once('open', resolve))
      const started = Date.now()
      expect(await closed).equals(1006)
      expect(Date.now() - started).within(150, 1000)
      expect(answers.ws.readyState).equals(WebSocket.OPEN)
      answers.ws.terminate()
    })
  })

  describe('losing the listener', function () {
    it('closes every socket with 1012 so its client reconnects and resyncs', async function () {
      const listener = await listen(VIEWER)
      await subscribed(listener, scored)
      await adminPool!.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
         where datname = $1 and query ilike 'listen %'`,
        [scratchName]
      )
      expect(await listener.closed).equals(1012)
      // It listens again, and a new socket hears the next change.
      await wait(200)
      const again = await listen(VIEWER)
      await subscribed(again, scored)
      const from = again.frames.length
      await apply(ball)
      await settled(again, from)
      again.ws.terminate()
    })
  })

  describe('stopping', function () {
    it('closes every socket with 1001 when the worker is told to stop', async function () {
      const listener = await listen(VIEWER)
      const before = socket!.size()
      expect(before).above(0)
      signals.emit('SIGTERM')
      expect(await listener.closed).equals(1001)
      await socket!.close()
      expect(signals.listenerCount('SIGTERM')).equals(0)
      // Nothing answers upgrades any more.
      const ws = new WebSocket(socketUrl, {
        headers: { authorization: `Bearer ${VIEWER}` }
      })
      ws.on('error', () => undefined)
      await wait(100)
      expect(ws.readyState).not.equals(WebSocket.OPEN)
      ws.terminate()
    })

    it('listens to the process by default', async function () {
      const plain = createServer()
      const before = process.listenerCount('SIGTERM')
      const handle = attachGameSocket(plain, db!, scratchUrl)
      expect(process.listenerCount('SIGTERM')).equals(before + 1)
      await handle.fanout.listening
      await handle.close()
      expect(process.listenerCount('SIGTERM')).equals(before)
    })
  })
})
