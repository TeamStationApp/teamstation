import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'
import WebSocket from 'ws'

import type { GameSocketReply } from '../../common/gameSocket'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import { FEED_APPLICATION_NAME, PostgresFeed } from '../changeFeed/postgresFeed'
import { type Database, makeDatabase } from '../db/database'
import {
  attachGameSocket,
  type GameSocketHandle,
  MAX_SUBSCRIPTIONS
} from './gameSocket'
import { ScreenScopeListener } from './screenScope'
import {
  bumpSyncClock,
  readSyncClock,
  SCREEN_SCOPES_CHANNEL,
  type ScreenScopeIds
} from './syncRevision'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

interface Listener {
  ws: WebSocket
  frames: GameSocketReply[]
  send: (frame: unknown) => void
  next: (
    match: (frame: GameSocketReply) => boolean,
    from?: number
  ) => Promise<GameSocketReply>
}

const VIEWER = 'tok_scope_viewer_00000000000000000'
const STRANGER = 'tok_scope_stranger_000000000000000'
const ADMIN = 'tok_scope_admin_000000000000000000'
const GUARDED = 'tok_scope_failing_00000000000000000'

/** The screen scopes on `/socket`, on a real server and a scratch database. */
describe('screen scopes on the game socket', function () {
  this.timeout(60000)
  const scratchName = `teamstation_screen_scope_${Date.now()}_${process.pid}`
  const scratchUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${scratchName}`)
  let admin: Pool
  let db: Kysely<Database>
  let server: Server
  let socket: GameSocketHandle
  let socketUrl = ''
  const logged: string[] = []
  const failing = new Set<string>()
  const listeners: Listener[] = []

  const taken = new Set<number>()
  const mint = (): { userId: number; legacyId: string } => {
    const minted = mintUserId(id => taken.has(id))
    taken.add(minted.userId)
    return minted
  }
  const viewer = mint()
  const stranger = mint()
  const boss = mint()
  const guarded = mint()
  const homeTeam = makeId('team')
  const awayTeam = makeId('team')
  const strangers = makeId('team')
  const season = makeId('season')
  const seen = makeId('game')
  const hidden = makeId('game')
  const failingGame = makeId('game')
  const many = Array.from({ length: MAX_SUBSCRIPTIONS }, () => makeId('game'))

  async function listen(token: string): Promise<Listener> {
    const ws = new WebSocket(socketUrl, {
      headers: { authorization: `Bearer ${token}` }
    })
    const frames: GameSocketReply[] = []
    ws.on('message', data => {
      frames.push(
        JSON.parse((data as Buffer).toString('utf8')) as GameSocketReply
      )
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
          await wait(10)
        }
      }
    }
    listeners.push(listener)
    return listener
  }

  /** Sends a request and waits for the answer to its id. */
  async function ask(
    listener: Listener,
    frame: Record<string, unknown>
  ): Promise<GameSocketReply> {
    const from = listener.frames.length
    const id = makeId('event')
    listener.send({ ...frame, id })
    return await listener.next(reply => 'id' in reply && reply.id === id, from)
  }

  /** Commits a write's revision, as a writing transaction ends. */
  async function commit(ids: ScreenScopeIds): Promise<string> {
    return await db
      .transaction()
      .execute(async trx => await bumpSyncClock(trx, ids))
  }

  /** The `changed` frames a listener heard from `from`. */
  const changes = (listener: Listener, from: number): GameSocketReply[] =>
    listener.frames.slice(from).filter(frame => frame.type === 'changed')

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const at = new Date()
    await insertFixtureUsers(
      db,
      [viewer, stranger, boss, guarded].map(user => ({
        id: user.userId,
        legacyId: user.legacyId,
        display_name: `User ${user.userId}`,
        is_admin: user === boss,
        created_at: at,
        updated_at: at
      }))
    )
    await db
      .insertInto('auth_sessions')
      .values(
        (
          [
            [viewer, VIEWER],
            [stranger, STRANGER],
            [boss, ADMIN],
            [guarded, GUARDED]
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
          id: seen,
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
        {
          id: failingGame,
          home_team_id: homeTeam,
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
        [viewer, guarded].map(user => ({
          id: makeId('membership'),
          user_id: userIdOfGumbo(user.userId),
          team_id: homeTeam,
          role: 'member'
        }))
      )
      .execute()

    server = createServer()
    socket = attachGameSocket(server, db, scratchUrl, {
      pingMs: 60_000,
      stopSignals: null,
      resyncSpreadMs: 0,
      fanout: { coalesceMs: 20, log: () => undefined },
      screenScopes: {
        coalesceMs: 80,
        log: message => {
          logged.push(message)
        }
      },
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
    await socket.screenScopes.listening
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    socketUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket`
  })

  after(async function () {
    for (const listener of listeners) listener.ws.terminate()
    await socket?.close()
    await new Promise<void>(resolve => {
      server?.close(() => {
        resolve()
      })
      server?.closeAllConnections()
    })
    await db?.destroy()
    await admin.query(`drop database if exists ${scratchName} with (force)`)
    await admin.end()
  })

  it('answers subscribed with the clock’s revision for home and schedule', async function () {
    const listener = await listen(VIEWER)
    const revision = await readSyncClock(db)
    expect(
      await ask(listener, { type: 'subscribe', scope: 'home' })
    ).deep.include({ type: 'subscribed', scope: 'home', revision })
    expect(
      await ask(listener, { type: 'subscribe', scope: 'schedule' })
    ).deep.include({ type: 'subscribed', scope: 'schedule', revision })
    expect(
      await ask(listener, { type: 'unsubscribe', scope: 'schedule' })
    ).deep.include({ type: 'unsubscribed', scope: 'schedule' })
  })

  it('refuses an event the person cannot see as notFound, and does not hold it', async function () {
    const listener = await listen(VIEWER)
    const refused = await ask(listener, {
      type: 'subscribe',
      scope: 'event',
      gameId: hidden
    })
    expect(refused).deep.include({ type: 'error', code: 'notFound' })
    expect(refused).not.have.property('gameId')
    const from = listener.frames.length
    await commit({ gameId: hidden })
    await wait(250)
    expect(changes(listener, from)).deep.equals([])
  })

  it('answers internal when the event cannot be checked, and holds nothing', async function () {
    const listener = await listen(VIEWER)
    failing.add(failingGame)
    try {
      expect(
        await ask(listener, {
          type: 'subscribe',
          scope: 'event',
          gameId: failingGame
        })
      ).deep.include({ type: 'error', code: 'internal' })
    } finally {
      failing.delete(failingGame)
    }
    expect(logged.some(line => line.includes('subscribe event'))).equals(true)
  })

  it('does not count an event scope under the game cap (Scope frame)', async function () {
    const listener = await listen(VIEWER)
    for (const gameId of many) {
      const from = listener.frames.length
      listener.send({ type: 'subscribe', gameId, id: `g-${gameId}` })
      await listener.next(
        frame => 'id' in frame && frame.id === `g-${gameId}`,
        from
      )
    }
    expect(
      await ask(listener, { type: 'subscribe', scope: 'event', gameId: seen })
    ).deep.include({ type: 'subscribed', scope: 'event' })
    // The cap is still full for games.
    expect(
      await ask(listener, { type: 'subscribe', gameId: seen })
    ).deep.include({ type: 'error', code: 'tooMany' })
  })

  it('refuses a scope frame that does not read, and still answers game frames (Game frames)', async function () {
    const listener = await listen(VIEWER)
    expect(
      await ask(listener, { type: 'subscribe', scope: 'event' })
    ).deep.include({ type: 'error', code: 'malformed' })
    expect(
      await ask(listener, { type: 'subscribe', scope: 'nowhere' })
    ).deep.include({ type: 'error', code: 'malformed' })
    expect(
      await ask(listener, { type: 'subscribe', gameId: seen })
    ).deep.include({ type: 'subscribed', gameId: seen })
  })

  it('tells an event, home and schedule of a game the person sees, and nobody else (Visibility)', async function () {
    const event = await listen(VIEWER)
    const home = await listen(VIEWER)
    const outsider = await listen(STRANGER)
    const everything = await listen(ADMIN)
    await ask(event, { type: 'subscribe', scope: 'event', gameId: seen })
    await ask(home, { type: 'subscribe', scope: 'home' })
    await ask(outsider, { type: 'subscribe', scope: 'schedule' })
    await ask(everything, { type: 'subscribe', scope: 'schedule' })
    const marks = [event, home, outsider, everything].map(
      listener => listener.frames.length
    )
    const revision = await commit({ gameId: seen })
    await event.next(frame => frame.type === 'changed', marks[0])
    await home.next(frame => frame.type === 'changed', marks[1])
    await everything.next(frame => frame.type === 'changed', marks[3])
    // Another game is not this event's.
    await commit({ gameId: hidden })
    await wait(250)
    expect(changes(event, marks[0])).deep.equals([
      { type: 'changed', scope: 'event', revision, gameId: seen }
    ])
    // Home is told which game, so a list that shows none lets it pass.
    expect(changes(home, marks[1])).deep.equals([
      { type: 'changed', scope: 'home', revision, gameId: seen }
    ])
    expect(changes(outsider, marks[2])).deep.equals([])
    expect(changes(everything, marks[3]).length).equals(2)
  })

  it('tells a schedule of a team it sees, and not one that does not see it (Team rename)', async function () {
    const member = await listen(VIEWER)
    const outsider = await listen(STRANGER)
    const event = await listen(VIEWER)
    await ask(member, { type: 'subscribe', scope: 'schedule' })
    await ask(outsider, { type: 'subscribe', scope: 'schedule' })
    await ask(event, { type: 'subscribe', scope: 'event', gameId: seen })
    const marks = [member, outsider, event].map(l => l.frames.length)
    const revision = await commit({ teamId: homeTeam })
    await member.next(frame => frame.type === 'changed', marks[0])
    // A season, or nothing at all, that this person is not in.
    await commit({ seasonId: season })
    await commit({})
    await wait(250)
    expect(changes(member, marks[0])).deep.equals([
      { type: 'changed', scope: 'schedule', revision }
    ])
    expect(changes(outsider, marks[1])).deep.equals([])
    expect(changes(event, marks[2])).deep.equals([])
  })

  it('tells a person’s own home of their change, even before they see the team', async function () {
    const own = await listen(STRANGER)
    const other = await listen(VIEWER)
    await ask(own, { type: 'subscribe', scope: 'home' })
    await ask(other, { type: 'subscribe', scope: 'home' })
    const marks = [own.frames.length, other.frames.length]
    const revision = await commit({
      userId: userIdOfGumbo(stranger.userId),
      teamId: strangers
    })
    await own.next(frame => frame.type === 'changed', marks[0])
    await wait(200)
    expect(changes(own, marks[0])).deep.equals([
      { type: 'changed', scope: 'home', revision }
    ])
    expect(changes(other, marks[1])).deep.equals([])
  })

  it('tells only the event of a game that has gone', async function () {
    const gone = makeId('game')
    await db
      .insertInto('games')
      .values({
        id: gone,
        home_team_id: homeTeam,
        away_team_id: awayTeam,
        start_at: new Date()
      })
      .execute()
    const event = await listen(VIEWER)
    const schedule = await listen(VIEWER)
    await ask(event, { type: 'subscribe', scope: 'event', gameId: gone })
    await ask(schedule, { type: 'subscribe', scope: 'schedule' })
    const marks = [event.frames.length, schedule.frames.length]
    await db.deleteFrom('games').where('id', '=', gone).execute()
    const revision = await commit({ gameId: gone })
    await event.next(frame => frame.type === 'changed', marks[0])
    await wait(200)
    expect(changes(event, marks[0])).deep.equals([
      { type: 'changed', scope: 'event', revision, gameId: gone }
    ])
    expect(changes(schedule, marks[1])).deep.equals([])
  })

  it('sends two notices for one game inside the window once, at the later revision (Coalesce)', async function () {
    const event = await listen(VIEWER)
    await ask(event, { type: 'subscribe', scope: 'event', gameId: seen })
    const from = event.frames.length
    await commit({ gameId: seen })
    const later = await commit({ gameId: seen })
    await event.next(frame => frame.type === 'changed', from)
    await wait(250)
    expect(changes(event, from)).deep.equals([
      { type: 'changed', scope: 'event', revision: later, gameId: seen }
    ])
  })

  it('replaces the scope a socket holds, and lets go only the one it names (Replaced scope)', async function () {
    const listener = await listen(VIEWER)
    await ask(listener, { type: 'subscribe', scope: 'event', gameId: seen })
    await ask(listener, { type: 'subscribe', scope: 'schedule' })
    // An unsubscribe for the scope just left does not release this one.
    expect(
      await ask(listener, { type: 'unsubscribe', scope: 'event', gameId: seen })
    ).deep.include({ type: 'unsubscribed', scope: 'event' })
    const from = listener.frames.length
    const revision = await commit({ gameId: seen })
    await listener.next(frame => frame.type === 'changed', from)
    await wait(200)
    expect(changes(listener, from)).deep.equals([
      { type: 'changed', scope: 'schedule', revision, gameId: seen }
    ])
    await ask(listener, { type: 'unsubscribe', scope: 'schedule' })
    const after = listener.frames.length
    await commit({ gameId: seen })
    await wait(250)
    expect(changes(listener, after)).deep.equals([])
  })

  it('takes scope requests in the order sent', async function () {
    const listener = await listen(VIEWER)
    // The event's check is slower than the unsubscribe behind it.
    listener.send({ type: 'subscribe', scope: 'event', gameId: seen, id: 'e1' })
    listener.send({ type: 'unsubscribe', scope: 'event', id: 'e2' })
    await listener.next(frame => 'id' in frame && frame.id === 'e2')
    expect(
      listener.frames
        .filter(frame => 'id' in frame)
        .map(frame => ('id' in frame ? frame.id : ''))
    ).deep.equals(['e1', 'e2'])
    const from = listener.frames.length
    await commit({ gameId: seen })
    await wait(250)
    expect(changes(listener, from)).deep.equals([])
  })

  it('logs a notify that does not read', async function () {
    const listener = await listen(VIEWER)
    await ask(listener, { type: 'subscribe', scope: 'home' })
    await sql`select pg_notify(${SCREEN_SCOPES_CHANNEL}, 'not json')`.execute(
      db
    )
    await sql`select pg_notify(${SCREEN_SCOPES_CHANNEL}, ${JSON.stringify({ revision: 'x' })})`.execute(
      db
    )
    const deadline = Date.now() + 3000
    while (logged.filter(line => line.includes('does not read')).length < 2) {
      if (Date.now() > deadline) throw new Error(JSON.stringify(logged))
      await wait(10)
    }
  })

  it('sends resync to every screen once it listens again after losing the connection', async function () {
    const home = await listen(VIEWER)
    const games = await listen(VIEWER)
    await ask(home, { type: 'subscribe', scope: 'home' })
    await ask(games, { type: 'subscribe', gameId: seen })
    const marks = [home.frames.length, games.frames.length]
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = $1 and application_name = $2`,
      [scratchName, FEED_APPLICATION_NAME]
    )
    expect(
      await home.next(frame => frame.type === 'resync', marks[0])
    ).deep.equals({ type: 'resync' })
    expect(logged.some(line => line.includes('lost the feed'))).equals(true)
    // The socket stays up, and a notice after the new LISTEN arrives.
    const revision = await commit({ gameId: seen })
    await home.next(
      frame => frame.type === 'changed' && frame.revision === revision,
      marks[0]
    )
    expect(
      games.frames.slice(marks[1]).some(frame => frame.type === 'resync')
    ).equals(false)
  })

  it('lets the listener close while a notice waits, and ignores one after', async function () {
    const delivered: string[] = []
    const feed = new PostgresFeed({
      databaseUrl: scratchUrl,
      log: () => undefined
    })
    const listener = new ScreenScopeListener({
      feed,
      coalesceMs: 1000,
      deliver: async payload => {
        delivered.push(payload.revision)
      },
      onResync: () => undefined
    })
    await listener.listening
    listener.notified(JSON.stringify({ revision: '1', gameId: seen }))
    listener.notified(JSON.stringify({ revision: '0', gameId: seen }))
    listener.notified(undefined)
    await listener.close()
    listener.notified(JSON.stringify({ revision: '2', gameId: seen }))
    await wait(50)
    expect(delivered).deep.equals([])
    await feed.close()
  })

  it('logs a delivery that fails', async function () {
    const lines: string[] = []
    const feed = new PostgresFeed({
      databaseUrl: scratchUrl,
      log: () => undefined
    })
    const failingDelivery = new ScreenScopeListener({
      feed,
      coalesceMs: 5,
      deliver: async () => {
        throw new Error('no socket')
      },
      onResync: () => {
        lines.push('resync')
      },
      log: line => {
        lines.push(line)
      }
    })
    await failingDelivery.listening
    failingDelivery.notified(JSON.stringify({ revision: '3' }))
    const deadline = Date.now() + 3000
    while (!lines.some(line => line.includes('no socket'))) {
      if (Date.now() > deadline) throw new Error(JSON.stringify(lines))
      await wait(5)
    }
    expect(lines).not.includes('resync')
    await failingDelivery.close()
  })

  it('treats a delivery with no connection in time as a gap, until it closes', async function () {
    const lines: string[] = []
    let release = (): void => undefined
    const feed = new PostgresFeed({
      databaseUrl: scratchUrl,
      log: () => undefined
    })
    const starved = new ScreenScopeListener({
      feed,
      coalesceMs: 5,
      deliver: async payload => {
        if (payload.revision === '5')
          await new Promise<void>(resolve => {
            release = resolve
          })
        throw new Error('timeout exceeded when trying to connect')
      },
      onResync: () => {
        lines.push('resync')
      },
      log: line => {
        lines.push(line)
      }
    })
    await starved.listening
    starved.notified(JSON.stringify({ revision: '4', gameId: seen }))
    const deadline = Date.now() + 3000
    while (!lines.includes('resync')) {
      if (Date.now() > deadline) throw new Error(JSON.stringify(lines))
      await wait(5)
    }
    expect(lines).length(2)
    expect(lines[0]).contains('no database connection in time')

    // One still reading when the listener closes has nobody left to tell.
    starved.notified(JSON.stringify({ revision: '5', gameId: seen }))
    await wait(50)
    await starved.close()
    release()
    await wait(10)
    expect(lines).length(2)
    await feed.close()
  })
})
