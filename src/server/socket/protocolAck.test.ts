import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { sql } from 'kysely'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import WebSocket from 'ws'

import {
  REVISION_HEADER,
  type SeasonGame,
  TeamStationClient
} from '../../common/api'
import {
  GAME_SOCKET_PROTOCOL,
  GameSocket,
  type ScreenScopeEvent,
  type WebSocketConstructor
} from '../../common/gameSocket'
import { makeId } from '../../common/ids'
import { ScreenScopeGate } from '../../common/screenScope'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { attachGameSocket, type GameSocketHandle } from './gameSocket'
import { bumpSyncClock, readSyncClock } from './syncRevision'

/**
 * S1: the schedule's acknowledgement comes before its `GET /events`, and a
 * score committed while that GET is out is never missed.
 *
 * The client is the app's own: `GameSocket` over a real socket, the
 * `TeamStationClient` and the screen gate. The score is committed the way a
 * writer does, with its notice as the transaction's last statements. Each
 * step is printed, so the run is its own log.
 */
describe('S1: subscribed comes before the schedule read, and a notice during it reads once more', function () {
  this.timeout(60000)
  let f: GroupFixture
  let server: Server
  let socket: GameSocketHandle
  let socketUrl = ''
  let gameId = ''
  let started = 0
  const trace: string[] = []
  const note = (line: string): void => {
    const entry = `${String(Date.now() - started).padStart(5)}ms ${line}`
    trace.push(line)
    console.log(`      ${entry}`)
  }

  beforeEach(async () => {
    trace.length = 0
    f = await groupFixture()
    const { rows } = await sql<{
      name: string
    }>`select current_database() as name`.execute(f.h.db)
    const databaseUrl = testDatabaseUrl.replace(/\/[^/]*$/, `/${rows[0].name}`)
    gameId = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date()
      })
      .execute()
    server = createServer()
    socket = attachGameSocket(server, f.h.db, databaseUrl, {
      pingMs: 60_000,
      stopSignals: null,
      log: () => undefined,
      fanout: { log: () => undefined }
    })
    await socket.fanout.listening
    await socket.screenScopes.listening
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    socketUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    started = Date.now()
  })

  afterEach(async () => {
    await socket?.close()
    await new Promise<void>(resolve => {
      server?.close(() => {
        resolve()
      })
      server?.closeAllConnections()
    })
    await f?.h.close()
  })

  /** Commits the score, as the scoring write does: rows, then the clock. */
  async function commitScore(): Promise<string> {
    return await f.h.db.transaction().execute(async trx => {
      await trx
        .updateTable('games')
        .set({ home_score: 3, away_score: 1, status: 'inProgress' })
        .where('id', '=', gameId)
        .execute()
      return await bumpSyncClock(trx, { gameId })
    })
  }

  /**
   * Runs the schedule as the app does, with the score committed `when` the
   * first `GET /events` is out: before the server reads it, or after the
   * server has answered and before the client has the answer.
   */
  async function schedule(
    when: 'beforeTheRead' | 'afterTheRead'
  ): Promise<{ gets: number; seen: SeasonGame | undefined }> {
    const token = f.h.tokens.get(101)!
    let gets = 0
    let committing: Promise<string> | undefined
    const fetchWithScore = (async (
      url: string,
      init: RequestInit
    ): Promise<Response> => {
      const first = gets === 0
      gets++
      note(`→ GET /events (#${gets})`)
      if (first && when === 'beforeTheRead') {
        committing = commitScore()
        note(`  score committed at revision ${await committing}`)
      }
      const response = await fetch(url, init)
      if (first && when === 'afterTheRead') {
        committing = commitScore()
        note(`  score committed at revision ${await committing}`)
      }
      note(
        `← 200 GET /events (#${gets}) ${REVISION_HEADER}: ${response.headers.get(REVISION_HEADER)}`
      )
      return response
    }) as unknown as typeof fetch
    const client = new TeamStationClient({
      baseUrl: `${f.h.origin}/api/v1`,
      token,
      fetch: fetchWithScore
    })
    const gameSocket = new GameSocket({
      baseUrl: socketUrl,
      token,
      WebSocketImpl: WebSocket as unknown as WebSocketConstructor
    })
    let seen: SeasonGame | undefined
    let loaded!: () => void
    let done = new Promise<void>(resolve => {
      loaded = resolve
    })
    const gate = new ScreenScopeGate({
      socket: {
        subscribeScope: (scope, listener) => {
          note(`→ subscribe ${scope.scope}`)
          return gameSocket.subscribeScope(scope, event => {
            note(`← ${JSON.stringify(event)}`)
            listener(event)
          })
        }
      },
      client,
      // The app's gate, its window shortened so the run stays short.
      coalesceMs: 300,
      load: async () => {
        const games = await client.games({})
        seen = games.find(game => game.id === gameId)
        note(
          `  schedule shows ${seen?.homeScore ?? '-'}–${seen?.awayScore ?? '-'}, holding revision ${client.revisionFor('/events')}`
        )
        loaded()
      }
    })
    gate.enter({ scope: 'schedule' })
    try {
      // The first read, and then a second for a read that would follow a
      // notice and never comes.
      await done
      done = new Promise<void>(resolve => {
        loaded = resolve
      })
      await Promise.race([
        done,
        new Promise(resolve => setTimeout(resolve, 1000))
      ])
      if (seen?.homeScore !== 3)
        throw new Error(`The score was missed: ${trace.join('\n')}`)
      await committing
      // Nothing more is read once the screen holds the score.
      await new Promise(resolve => setTimeout(resolve, 600))
    } finally {
      gate.leave()
      gameSocket.close()
    }
    return { gets, seen }
  }

  /** Where the acknowledgement and the first GET fall in the trace. */
  const ackedBeforeTheRead = (): void => {
    expect(trace.indexOf('← {"type":"subscribed"}')).within(
      0,
      trace.indexOf('→ GET /events (#1)')
    )
  }

  /** The game's notice, as the screen hears it: no revision, only its id. */
  const notice = (): string => `← {"type":"changed","gameId":"${gameId}"}`

  it('reads once more when the score commits before the GET’s snapshot: no revision tells the notice apart', async function () {
    note('score commits before the server reads')
    const { gets, seen } = await schedule('beforeTheRead')
    ackedBeforeTheRead()
    expect(seen).deep.include({ homeScore: 3, awayScore: 1 })
    expect(trace).includes(notice())
    expect(gets).equals(2)
  })

  it('reads once more when the score commits after the GET’s snapshot, and then has it', async function () {
    note('score commits after the server answered, before the client has it')
    const { gets, seen } = await schedule('afterTheRead')
    ackedBeforeTheRead()
    expect(trace).includes(notice())
    expect(trace.indexOf(notice())).lessThan(
      trace.indexOf('→ GET /events (#2)')
    )
    expect(seen).deep.include({ homeScore: 3, awayScore: 1 })
    expect(gets).equals(2)
  })

  it('tells the app to update when the server refuses its scope as too old', async function () {
    const plain = createServer()
    const strict = attachGameSocket(plain, f.h.db, testDatabaseUrl, {
      feed: {
        subscribe: () => ({
          listening: Promise.resolve(),
          stop: () => undefined
        }),
        publishEphemeral: async () => undefined,
        close: async () => undefined
      },
      stopSignals: null,
      log: () => undefined,
      minimumProtocol: GAME_SOCKET_PROTOCOL + 1
    })
    await new Promise<void>(resolve => {
      plain.listen(0, '127.0.0.1', resolve)
    })
    const gameSocket = new GameSocket({
      baseUrl: `http://127.0.0.1:${(plain.address() as AddressInfo).port}/api/v1`,
      token: f.h.tokens.get(101)!,
      WebSocketImpl: WebSocket as unknown as WebSocketConstructor
    })
    try {
      let told = 0
      gameSocket.onUpdateRequired(() => {
        told++
      })
      const heard: ScreenScopeEvent[] = []
      gameSocket.subscribeScope({ scope: 'home' }, event => heard.push(event))
      const deadline = Date.now() + 5000
      while (heard.length === 0) {
        if (Date.now() > deadline) throw new Error('No answer to the scope')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      note(`← ${JSON.stringify(heard[0])}`)
      expect(heard).deep.equals([
        {
          type: 'error',
          code: 'forbidden',
          message: 'Update TeamStation to keep following games.'
        }
      ])
      expect(told).equals(1)
    } finally {
      gameSocket.close()
      await strict.close()
      await new Promise(resolve => plain.close(resolve))
    }
  })
})

/** The reads a subscribed screen makes, each at the revision it read. */
describe('the revision on every read a screen scope uses', function () {
  this.timeout(60000)
  let f: GroupFixture
  let gameId = ''

  before(async () => {
    f = await groupFixture()
    gameId = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date()
      })
      .execute()
  })

  after(async () => {
    await f?.h.close()
  })

  it('answers each GET the phone caches with x-teamstation-revision', async function () {
    const reads = [
      '/teams',
      '/seasons',
      '/me/groups',
      '/me/follows',
      '/users?guardedBy=me',
      '/events',
      '/events?when=upcoming',
      '/me/roles',
      '/me/home',
      `/teams/${f.teamA}/roster`,
      `/teams/${f.teamA}/roster?includeFullNames=true`,
      `/games/${gameId}`,
      `/games/${gameId}/lineups`,
      `/games/${gameId}/events`,
      `/teams/${f.teamA}/default-lineup`
    ]
    const before = await readSyncClock(f.h.db)
    for (const read of reads) {
      const response = await f.h.request('GET', read, undefined, 101)
      expect(response.status, read).equals(200)
      expect(response.headers.get(REVISION_HEADER), read).equals(before)
    }
    const revision = await f.h.db
      .transaction()
      .execute(async trx => await bumpSyncClock(trx, { teamId: f.teamA }))
    for (const read of reads) {
      const response = await f.h.request('GET', read, undefined, 101)
      expect(response.headers.get(REVISION_HEADER), read).equals(revision)
    }
  })

  it('answers the events beneath an open post with an older revision, and the post with its own', async function () {
    let release!: () => void
    const mayCommit = new Promise<void>(resolve => {
      release = resolve
    })
    let locked!: () => void
    const hasLocked = new Promise<void>(resolve => {
      locked = resolve
    })
    // A live post: it holds the game, writes, and takes the next revision.
    const post = f.h.db.transaction().execute(async trx => {
      await trx
        .selectFrom('games')
        .select('id')
        .where('id', '=', gameId)
        .forUpdate()
        .executeTakeFirst()
      await trx
        .updateTable('games')
        .set({ home_score: 1 })
        .where('id', '=', gameId)
        .execute()
      const revision = await bumpSyncClock(trx, { gameId })
      locked()
      await mayCommit
      return revision
    })
    await hasLocked
    const reading = f.h.request(
      'GET',
      `/games/${gameId}/events`,
      undefined,
      101
    )
    // It does not wait for the post, and shows nothing the post wrote.
    const response = await reading
    expect(response.status).equals(200)
    const before = response.headers.get(REVISION_HEADER)
    release()
    const revision = await post
    expect(BigInt(before!) < BigInt(revision)).equals(true)
    const after = await f.h.request(
      'GET',
      `/games/${gameId}/events`,
      undefined,
      101
    )
    expect(after.headers.get(REVISION_HEADER)).equals(revision)
  })
})
