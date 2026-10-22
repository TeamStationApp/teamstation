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
import { GameSocket, type WebSocketConstructor } from '../../common/gameSocket'
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
 * writer does, with the clock bumped as the transaction's last statements.
 * Each step is printed, so the run is its own log.
 */
describe('S1: subscribed comes before the schedule read, and the revision orders the overlap', function () {
  this.timeout(60000)
  let f: GroupFixture
  let server: Server
  let socket: GameSocketHandle
  let socketUrl = ''
  let gameId = ''
  let started = 0
  /** The clock once the fixture is built: its own writes bump it too. */
  let base = 0n
  const at = (step: bigint): string => String(base + step)
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
    base = BigInt(await readSyncClock(f.h.db))
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
            note(
              `← ${event.type}${'revision' in event ? ` revision ${event.revision}` : ''}`
            )
            listener(event)
          })
        }
      },
      client,
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

  it('reads once when the score commits before the GET’s snapshot: the answer already has it', async function () {
    note('score commits before the server reads')
    const { gets, seen } = await schedule('beforeTheRead')
    expect(trace.indexOf(`← subscribed revision ${at(0n)}`)).lessThan(
      trace.indexOf('→ GET /events (#1)')
    )
    expect(seen).deep.include({ homeScore: 3, awayScore: 1 })
    expect(gets).equals(1)
    // The notice is at or below the answer's revision, so it is a no-op.
    const header = trace.find(line => line.startsWith('← 200 GET /events (#1)'))
    const notice = trace.find(line => line.startsWith('← changed'))
    expect(header).includes(`${REVISION_HEADER}: ${at(1n)}`)
    expect(notice).equals(`← changed revision ${at(1n)}`)
  })

  it('reads once more when the score commits after the GET’s snapshot: the notice is newer', async function () {
    note('score commits after the server answered, before the client has it')
    const { gets, seen } = await schedule('afterTheRead')
    expect(trace.indexOf(`← subscribed revision ${at(0n)}`)).lessThan(
      trace.indexOf('→ GET /events (#1)')
    )
    expect(
      trace.find(line => line.startsWith('← 200 GET /events (#1)'))
    ).includes(`${REVISION_HEADER}: ${at(0n)}`)
    expect(trace).includes(`← changed revision ${at(1n)}`)
    expect(
      trace.find(line => line.startsWith('← 200 GET /events (#2)'))
    ).includes(`${REVISION_HEADER}: ${at(1n)}`)
    expect(seen).deep.include({ homeScore: 3, awayScore: 1 })
    expect(gets).equals(2)
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

  it('reads the events’ revision after their lock, so a post that held the game is in it', async function () {
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
    await new Promise(resolve => setTimeout(resolve, 200))
    release()
    const revision = await post
    const response = await reading
    expect(response.status).equals(200)
    expect(response.headers.get(REVISION_HEADER)).equals(revision)
  })
})
