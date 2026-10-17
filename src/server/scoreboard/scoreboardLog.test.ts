import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'

import { NO_OVERRIDES } from '../../common/scoreboard'
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
  testPrefix,
  until
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { attachScoreboard } from './attachScoreboard'
import { makeScoreboardHub } from './scoreboardHub'
import { logScoreboard } from './scoreboardLog'
import {
  makeScoreboardStore,
  makeScoreboardSubscriber,
  type ScoreboardStore,
  type WriteResult
} from './scoreboardStore'

/**
 * The scoreboard log, written by the hub on a real HTTP server and a real
 * Redis, against a scratch database. The hub's clock is the test's, so each
 * row's `at` and `receivedAt` are known.
 */

const HOUR = 3_600_000

interface Worker {
  url: string
  store: ScoreboardStore
  /** What each of the store's publisher and override writes returned. */
  results: WriteResult[]
  close: () => Promise<void>
}

interface Probe {
  socket: WebSocket
  messages: any[]
  opened: Promise<void>
}

describe('the scoreboard log', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let prefix = ''
  let clock = Date.now()
  const now = (): number => clock
  let runner: Person
  let home = ''
  let away = ''
  const workers: Worker[] = []
  const probes: Probe[] = []
  const logged: string[] = []

  async function startWorker(
    options: { speedHoldMs?: number; db?: Kysely<Database> } = {}
  ): Promise<Worker> {
    const client = await connectedClient()
    const subscriber = makeScoreboardSubscriber(client, quiet)
    await subscriber.connect()
    const store = makeScoreboardStore({ client, prefix, now })
    const results: WriteResult[] = []
    const recorded =
      <A extends unknown[]>(write: (...args: A) => Promise<WriteResult>) =>
      async (...args: A): Promise<WriteResult> => {
        const result = await write(...args)
        results.push(result)
        return result
      }
    store.mergeWatcher = recorded(store.mergeWatcher)
    store.writeOverrides = recorded(store.writeOverrides)
    store.resetScoreboard = recorded(store.resetScoreboard)
    const hub = makeScoreboardHub({
      db: options.db ?? db,
      store,
      subscriber,
      log: line => logged.push(line),
      now,
      speedHoldMs: options.speedHoldMs
    })
    const server: Server = createServer((req, res) => {
      res.statusCode = 404
      res.end()
    })
    const close = attachScoreboard(server, hub)
    server.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    const worker: Worker = {
      url: `ws://127.0.0.1:${port}/api/v1/scoreboard`,
      store,
      results,
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
      messages: [],
      opened: new Promise(resolve =>
        socket.once('open', () => {
          resolve()
        })
      )
    }
    socket.on('message', data => {
      probe.messages.push(JSON.parse((data as Buffer).toString('utf8')))
    })
    socket.on('error', () => undefined)
    probes.push(probe)
    return probe
  }
  async function publisher(worker: Worker, gameId: string): Promise<Probe> {
    const probe = connect(`${worker.url}/${gameId}/publish`, runner)
    await probe.opened
    return probe
  }
  async function dashboard(worker: Worker, gameId: string): Promise<Probe> {
    const probe = connect(`${worker.url}/${gameId}/dashboard`, runner)
    await probe.opened
    return probe
  }
  const send = (probe: Probe, value: unknown): void => {
    probe.socket.send(JSON.stringify(value))
  }
  async function newGame(startAt = new Date(clock)): Promise<string> {
    return await addGame(db, { homeTeamId: home, awayTeamId: away, startAt })
  }
  async function rows(gameId: string): Promise<any[]> {
    return await db
      .selectFrom('scoreboard_log')
      .selectAll()
      .where('game_id', '=', gameId)
      .orderBy('version')
      .execute()
  }
  async function rowCount(gameId: string, count: number): Promise<any[]> {
    let found: any[] = []
    await until(`${count} rows (have ${found.length})`, async () => {
      found = await rows(gameId)
      return found.length >= count
    })
    return found
  }
  const written = (result: WriteResult | undefined): number => {
    if (result?.kind !== 'written') throw new Error('not written')
    return result.now
  }
  const countOverride = {
    ...NO_OVERRIDES,
    overrideCountEnabled: true,
    overrideCount: { balls: 3, strikes: 1, outs: 2 }
  }

  before(async function () {
    await requireRedis()
    ;({ db, drop } = await scratchDatabase('scoreboard_log'))
    prefix = testPrefix()
    home = await addTeam(db, 'Pioneers')
    away = await addTeam(db, 'Visitors')
    runner = await addPerson(db, 'runner', { owns: home })
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

  it('logs a publisher packet that changes the board as one whole row (U5)', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const phone = await publisher(worker, gameId)
    clock += 1000
    send(phone, { balls: 2, strikes: 1, homeTeam: 'WRONG' })
    const [row] = await rowCount(gameId, 1)
    const at = written(worker.results[0])
    expect(at).equals(clock)
    expect(row).deep.equals({
      game_id: gameId,
      version: at * 1000,
      at: new Date(at),
      cause: 'publisher',
      actor_id: runner.userId,
      publisher: { state: { balls: 2, strikes: 1 }, receivedAt: at },
      overrides: NO_OVERRIDES
    })
    expect(row.actor_id).is.a('number')
  })

  it('skips an uncontested packet that changes nothing, and logs a repeated contested one (U6)', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const phone = await publisher(worker, gameId)
    const first = clock
    send(phone, { balls: 1, pitchSpeed: 0 })
    await rowCount(gameId, 1)
    clock += 1000
    send(phone, { pitchSpeed: 0 })
    clock += 1000
    send(phone, { balls: 1 })
    const logged = await rowCount(gameId, 2)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await rows(gameId)).has.length(2)
    expect(logged.map(row => row.publisher)).deep.equals([
      { state: { balls: 1, pitchSpeed: 0 }, receivedAt: first },
      { state: { balls: 1, pitchSpeed: 0 }, receivedAt: first + 2000 }
    ])
    expect(worker.results).has.length(3)
  })

  it('skips a speed of 0 on a slot that never had a speed, as the board already showed 0 (U6)', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const phone = await publisher(worker, gameId)
    const first = clock
    send(phone, { balls: 3, strikes: 0 })
    await rowCount(gameId, 1)
    clock += 1000
    send(phone, { pitchSpeed: 0, exitVelocity: 0, batterNumber: 0 })
    clock += 1000
    send(phone, { pitchSpeed: 61 })
    const logged = await rowCount(gameId, 2)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await rows(gameId)).has.length(2)
    expect(logged.map(row => row.publisher)).deep.equals([
      { state: { balls: 3, strikes: 0 }, receivedAt: first },
      {
        state: {
          balls: 3,
          strikes: 0,
          pitchSpeed: 61,
          exitVelocity: 0,
          batterNumber: 0
        },
        receivedAt: first
      }
    ])
    expect(worker.results).has.length(3)
  })

  it('skips a row no newer than the newest logged, as from a slower worker (U7)', async function () {
    const gameId = await newGame()
    const row = {
      gameId,
      at: clock,
      cause: 'publisher' as const,
      actorId: runner.userId,
      overrides: NO_OVERRIDES
    }
    expect(
      await logScoreboard(db, {
        ...row,
        version: 20,
        publisher: { state: { outs: 2 }, receivedAt: clock }
      })
    ).equals('inserted')
    expect(
      await logScoreboard(db, {
        ...row,
        version: 10,
        publisher: { state: { outs: 1 }, receivedAt: clock - 1 }
      })
    ).equals('skipped')
    expect(
      await logScoreboard(db, {
        ...row,
        version: 20,
        publisher: { state: { outs: 0 }, receivedAt: clock }
      })
    ).equals('skipped')
    // Concurrent rows wait for each other: the lock keeps both from reading
    // the same newest row.
    const both = await Promise.all([
      logScoreboard(db, {
        ...row,
        version: 30,
        publisher: { state: { outs: 0 }, receivedAt: clock }
      }),
      logScoreboard(db, {
        ...row,
        version: 31,
        publisher: { state: { outs: 1 }, receivedAt: clock }
      })
    ])
    expect(both).includes('inserted')
    const versions = (await rows(gameId)).map(found => found.version)
    expect(versions[0]).equals(20)
    expect(versions.at(-1)).equals(31)
  })

  it('logs nothing for a game write, a closed board or a stale write, and survives a failed log (U8)', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const viewer = connect(`${worker.url}/${gameId}/socket`)
    await until('the first board', () => viewer.messages.length >= 1)
    await worker.store.writeGame(gameId, { balls: 2 }, clock, 200)
    expect(
      await worker.store.writeGame(gameId, { balls: 1 }, clock, 100)
    ).deep.equals({ kind: 'stale' })
    await until('the game write', () => viewer.messages.at(-1)?.balls === 2)

    // The board closes between the hub's check and the write: the hub is
    // told the key is there, and the script finds it is not.
    const old = await newGame(new Date(clock - HOUR))
    const late = await publisher(worker, old)
    worker.store.exists = async () => true
    clock += HOUR + 1000
    send(late, { balls: 1 })
    await until('a closed write', () =>
      worker.results.some(result => result.kind === 'closed')
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await rows(gameId)).deep.equals([])
    expect(await rows(old)).deep.equals([])

    // A database that cannot log: the write still reaches the viewer.
    clock = Date.now()
    const broken = new Proxy(db, {
      get: (target, name) => {
        if (name === 'transaction') {
          return () => {
            throw new Error('the log fell over')
          }
        }
        // Kysely's own methods read private fields, so they run on the
        // database itself rather than on the proxy.
        const value = Reflect.get(target, name)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const failing = await startWorker({ db: broken })
    const third = await newGame()
    const watching = connect(`${failing.url}/${third}/socket`)
    await until('the first board', () => watching.messages.length >= 1)
    const phone = await publisher(failing, third)
    send(phone, { balls: 3 })
    await until('balls 3', () => watching.messages.at(-1)?.balls === 3)
    await until('the failure to be reported', () =>
      logged.some(line =>
        line.includes(`scoreboard ${third}: scoreboard log: the log fell over`)
      )
    )
    send(phone, { strikes: 2 })
    await until('strikes 2', () => watching.messages.at(-1)?.strikes === 2)
    expect(await rows(third)).deep.equals([])
  })

  it('records each cause: publisher, speed hold, dashboard and reset (U9)', async function () {
    const worker = await startWorker({ speedHoldMs: 50 })
    const gameId = await newGame()
    const phone = await publisher(worker, gameId)
    const board = await dashboard(worker, gameId)
    send(phone, { balls: 1, pitchSpeed: 88 })
    await rowCount(gameId, 2)
    send(board, { type: 'overrides', data: countOverride })
    await rowCount(gameId, 3)
    // The same overrides again change nothing.
    send(board, { type: 'overrides', data: countOverride })
    send(board, { type: 'reset' })
    const logged = await rowCount(gameId, 4)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await rows(gameId)).has.length(4)
    expect(
      logged.map(row => [row.cause, row.actor_id, row.publisher?.state])
    ).deep.equals([
      ['publisher', runner.userId, { balls: 1, pitchSpeed: 88 }],
      ['speedHold', null, { balls: 1, pitchSpeed: 0 }],
      ['dashboard', runner.userId, { balls: 1, pitchSpeed: 0 }],
      ['reset', runner.userId, undefined]
    ])
    expect(logged[2].overrides).deep.equals(countOverride)
    expect(logged[3].publisher).equals(null)
    expect(logged[3].overrides).deep.equals(NO_OVERRIDES)
  })

  it('logs a radar speed and keeps the publisher’s receivedAt (U10)', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const phone = await publisher(worker, gameId)
    const contested = clock
    send(phone, { balls: 1 })
    await rowCount(gameId, 1)
    clock += 2500
    send(phone, { pitchSpeed: 61 })
    const [, speed] = await rowCount(gameId, 2)
    expect(speed.at).deep.equals(new Date(contested + 2500))
    expect(speed.publisher).deep.equals({
      state: { balls: 1, pitchSpeed: 61 },
      receivedAt: contested
    })
  })
})
