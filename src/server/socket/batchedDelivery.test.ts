import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'
import { WebSocket } from 'ws'

import { openScratch, type Scratch } from '../../../tools/dbLoad/testSupport'
import { makeId } from '../../common/ids'
import type { GameScope } from '../access'
import { createSession, revokeSession } from '../auth/sessions'
import type { ChangeFeed, FeedChannel, FeedHandlers } from '../changeFeed/feed'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { insertUser } from '../users/insertUser'
import type { FanoutSubscriber } from './fanout'
import {
  attachGameSocket,
  authorizeSubscribers,
  type GameSocketHandle
} from './gameSocket'

const MANY = 200

interface Person {
  userId: string
  token: string
}

/** A feed the test speaks through, so nothing but it wakes the socket. */
function handFeed(): {
  feed: ChangeFeed
  say: (channel: FeedChannel, payload: unknown) => void
} {
  const handlers = new Map<FeedChannel, FeedHandlers>()
  return {
    feed: {
      subscribe: (channel, handler) => {
        handlers.set(channel, handler)
        return { listening: Promise.resolve(), stop: () => undefined }
      },
      publishEphemeral: async () => undefined,
      close: async () => undefined
    },
    say: (channel, payload) => {
      handlers.get(channel)?.onPayload(JSON.stringify(payload))
    }
  }
}

describe('authorizing a delivery in one set of reads', function () {
  this.timeout(120_000)

  let scratch: Scratch
  let counting: Kysely<Database>
  let server: Server
  let socket: GameSocketHandle
  let socketUrl = ''
  let now = 1_000_000
  const statements: string[] = []
  const said = handFeed()
  const open: WebSocket[] = []

  const home = makeId('team')
  const away = makeId('team')
  const otherTeam = makeId('team')
  const season = makeId('season')
  const game = makeId('game')
  const scope: GameScope = {
    homeTeamId: home,
    awayTeamId: away,
    seasonId: season
  }
  const members: Person[] = []
  let strangers: Person[] = []
  let otherMembers: Person[] = []

  async function person(teamId?: string): Promise<Person> {
    const db = scratch.db
    const userId = await db.transaction().execute(async trx => {
      return await insertUser(trx, {
        display_name: 'Load Viewer',
        first_name: 'Load',
        last_name: 'Viewer',
        birth_year: 1985,
        birth_month: 6,
        login_enabled: true
      })
    })
    if (teamId != null)
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teamId,
          role: 'member'
        })
        .execute()
    const { token } = await createSession(db, userId, 'batched delivery')
    return { userId, token }
  }

  function subscriberOf(someone: Person): FanoutSubscriber & {
    signedOutCount: () => number
  } {
    let signedOut = 0
    return {
      token: someone.token,
      userId: someone.userId,
      send: () => undefined,
      resync: () => undefined,
      signedOut: () => {
        signedOut += 1
      },
      signedOutCount: () => signedOut
    }
  }

  /** A socket, keeping every frame. */
  async function connect(token: string): Promise<{
    ws: WebSocket
    frames: Array<Record<string, unknown>>
    closed: Promise<number>
    ask: (frame: object, id: string) => Promise<void>
  }> {
    const ws = new WebSocket(socketUrl, {
      headers: { authorization: `Bearer ${token}` }
    })
    open.push(ws)
    const frames: Array<Record<string, unknown>> = []
    ws.on('message', data => {
      frames.push(
        JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>
      )
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
    return {
      ws,
      frames,
      closed,
      ask: async (frame, id) => {
        ws.send(JSON.stringify({ ...frame, id }))
        await until(() => frames.some(each => each.id === id), `reply ${id}`)
      }
    }
  }

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Never saw ${what}`)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  before(async function () {
    attachInt8Parser()
    scratch = await openScratch('delivery')
    counting = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: scratch.url, max: 4 })
      }),
      log: event => {
        statements.push(event.query.sql)
      }
    })
    const { db } = scratch
    await db
      .insertInto('teams')
      .values(
        [home, away, otherTeam].map(id => ({ id, name: id, kind: 'full' }))
      )
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: season,
        league_id: null,
        name: 'Load season',
        year: 2026,
        term: 'Spring',
        starts_on: '2026-03-01',
        ends_on: '2026-05-31'
      })
      .execute()
    await db
      .insertInto('games')
      .values({
        id: game,
        home_team_id: home,
        away_team_id: away,
        season_id: season,
        start_at: new Date(),
        venue: 'Load Field',
        status: 'scheduled'
      })
      .execute()
    for (let i = 0; i < MANY; i++) members.push(await person(home))
    strangers = [await person(), await person()]
    otherMembers = [await person(otherTeam), await person(otherTeam)]

    server = createServer()
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    socketUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket`
    socket = attachGameSocket(server, counting, scratch.url, {
      feed: said.feed,
      recheckMs: 60_000,
      clock: () => now,
      stopSignals: null,
      resyncSpreadMs: 0,
      fanout: { coalesceMs: 0, log: () => undefined },
      screenScopes: { coalesceMs: 0, log: () => undefined }
    })
  })

  after(async function () {
    for (const ws of open) ws.terminate()
    await socket.close()
    await new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    })
    await counting.destroy()
    await scratch.drop()
  })

  beforeEach(function () {
    statements.length = 0
  })

  const log = (): undefined => undefined

  describe('authorizeSubscribers', function () {
    it('reads nothing for nobody', async function () {
      expect(await authorizeSubscribers([], scope, counting, log)).deep.equals(
        []
      )
      expect(statements).deep.equals([])
    })

    it('runs the same statements for one subscriber as for two hundred', async function () {
      const one = await authorizeSubscribers(
        [subscriberOf(members[0])],
        scope,
        counting,
        log
      )
      const forOne = [...statements]
      statements.length = 0
      const all = await authorizeSubscribers(
        members.map(subscriberOf),
        scope,
        counting,
        log
      )
      expect(one).deep.equals([true])
      expect(all).deep.equals(members.map(() => true))
      expect(statements).deep.equals(forOne)
      expect(forOne.length).below(15)
    })

    it('tells each subscriber their own answer, in their order', async function () {
      const revoked = await person(home)
      await revokeSession(scratch.db, revoked.token)
      const impostor = subscriberOf({
        userId: strangers[0].userId,
        token: members[1].token
      })
      const refused = subscriberOf(revoked)
      const seeing = await authorizeSubscribers(
        [
          subscriberOf(strangers[1]),
          subscriberOf(members[2]),
          refused,
          subscriberOf(otherMembers[0]),
          impostor,
          subscriberOf(members[2])
        ],
        scope,
        counting,
        log
      )
      expect(seeing).deep.equals([false, true, false, false, false, true])
      expect(refused.signedOutCount()).equals(1)
      expect(impostor.signedOutCount()).equals(1)
    })

    it('sends nobody anything when the reads fail', async function () {
      const logged: string[] = []
      const broken = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new Pool({
            connectionString: 'postgres://127.0.0.1:1/nothing',
            max: 1
          })
        })
      })
      const first = subscriberOf(members[0])
      const seeing = await authorizeSubscribers(
        [first, subscriberOf(members[1])],
        scope,
        broken,
        message => {
          logged.push(message)
        }
      )
      expect(seeing).deep.equals([false, false])
      expect(first.signedOutCount()).equals(0)
      expect(logged).to.have.length(1)
      await broken.destroy()
    })
  })

  describe('a live delivery', function () {
    it('closes a subscriber signed out between messages with 1008, sends them nothing, and stops one removed from the team', async function () {
      const leaving = await person(home)
      const removed = await person(home)
      const staying = await person(home)
      const out = await connect(leaving.token)
      const gone = await connect(removed.token)
      const still = await connect(staying.token)
      for (const each of [out, gone, still])
        await each.ask({ type: 'subscribe', gameId: game }, 'sub')
      const changes = (frames: Array<Record<string, unknown>>): number =>
        frames.filter(frame => frame.type === 'change').length

      said.say('game_changes', { game, kind: 'game' })
      await until(
        () => [out, gone, still].every(each => changes(each.frames) === 1),
        'the first change everywhere'
      )

      await revokeSession(scratch.db, leaving.token)
      await scratch.db
        .deleteFrom('memberships')
        .where('user_id', '=', removed.userId)
        .execute()
      said.say('game_changes', { game, kind: 'plays' })
      await until(() => changes(still.frames) === 2, 'the second change')
      expect(await out.closed).equals(1008)
      expect(changes(out.frames)).equals(1)
      expect(changes(gone.frames)).equals(1)
      expect(gone.ws.readyState).equals(WebSocket.OPEN)
    })

    it('runs the same statements to deliver to one socket as to many', async function () {
      const first = await connect(members[0].token)
      await first.ask({ type: 'subscribe', gameId: game }, 'sub')
      const changes = (frames: Array<Record<string, unknown>>): number =>
        frames.filter(frame => frame.type === 'change').length
      statements.length = 0
      said.say('game_changes', { game, kind: 'game' })
      await until(() => changes(first.frames) === 1, 'one socket told')
      const forOne = [...statements]

      const rest = await Promise.all(
        members.slice(1, 50).map(async member => await connect(member.token))
      )
      await Promise.all(
        rest.map(async each => {
          await each.ask({ type: 'subscribe', gameId: game }, 's')
        })
      )
      statements.length = 0
      said.say('game_changes', { game, kind: 'game' })
      await until(
        () => rest.every(each => changes(each.frames) === 1),
        'every socket told'
      )
      expect(statements).deep.equals(forOne)
      for (const each of [first, ...rest]) each.ws.terminate()
    })
  })

  describe('a screen notice', function () {
    const told = (frames: Array<Record<string, unknown>>): boolean =>
      frames.some(frame => frame.type === 'changed')
    let revision = 1
    const revisionNext = (): string => String((revision += 1))

    it('runs the same statements for two hundred stale sockets as for one, and tells exactly those who may see it', async function () {
      // One stale socket.
      const lone = await connect(members[0].token)
      await lone.ask({ type: 'subscribe', scope: 'home' }, 'home')
      now += 120_000
      statements.length = 0
      said.say('screen_scopes', { gameId: game, revision: revisionNext() })
      await until(() => told(lone.frames), 'the one told')
      const forOne = [...statements]
      lone.ws.terminate()

      // Two hundred, and some who may not see it, all stale.
      const sockets = await Promise.all(
        members.map(async member => await connect(member.token))
      )
      const others = await Promise.all(
        [...strangers, ...otherMembers].map(
          async someone => await connect(someone.token)
        )
      )
      await Promise.all(
        [...sockets, ...others].map(async each => {
          await each.ask({ type: 'subscribe', scope: 'home' }, 'home')
        })
      )
      now += 120_000
      statements.length = 0
      said.say('screen_scopes', { gameId: game, revision: revisionNext() })
      await until(
        () => sockets.every(each => told(each.frames)),
        'every member told'
      )
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(statements).deep.equals(forOne)
      for (const each of others) expect(told(each.frames)).equals(false)

      // Copies still good read nothing but the game; a team's notice needs
      // not even that, and reaches its members alone.
      statements.length = 0
      said.say('screen_scopes', { teamId: otherTeam, revision: revisionNext() })
      await until(
        () => others.slice(2).every(each => told(each.frames)),
        "the other team's members told"
      )
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(statements).deep.equals([])
      for (const each of others.slice(0, 2))
        expect(told(each.frames)).equals(false)
      for (const each of [...sockets, ...others]) each.ws.terminate()
    })

    it('keeps its own and other-event sockets out of the read', async function () {
      const mine = await connect(strangers[0].token)
      const elsewhere = await connect(members[3].token)
      await mine.ask({ type: 'subscribe', scope: 'home' }, 'home')
      await elsewhere.ask(
        { type: 'subscribe', scope: 'event', gameId: game },
        'event'
      )
      now += 120_000
      statements.length = 0
      said.say('screen_scopes', {
        userId: strangers[0].userId,
        revision: revisionNext()
      })
      await until(() => told(mine.frames), 'their own notice')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(statements).deep.equals([])
      expect(told(elsewhere.frames)).equals(false)
      mine.ws.terminate()
      elsewhere.ws.terminate()
    })

    it('tells a home screen nothing of a game nobody has', async function () {
      const holding = await connect(members[4].token)
      await holding.ask({ type: 'subscribe', scope: 'home' }, 'home')
      now += 120_000
      // A notice of a game nobody has: a home screen is not told.
      said.say('screen_scopes', {
        gameId: 'gam_nosuch',
        revision: revisionNext()
      })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(told(holding.frames)).equals(false)
      holding.ws.terminate()
    })
  })
})
