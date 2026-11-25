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
  addScorableTeams,
  addTeam,
  connectedClient,
  dropPrefix,
  type Person,
  quiet,
  requireRedis,
  scoreDirectly,
  scratchDatabase,
  testPrefix,
  until
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { attachScoreboard } from './attachScoreboard'
import { computeBoardTimeline, makeBoardTimelineCache } from './boardTimeline'
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
      radar: null,
      game_id: gameId,
      version: at * 1000,
      at: new Date(at),
      cause: 'publisher',
      actor_id: runner.userId,
      publisher: { state: { balls: 2, strikes: 1 }, receivedAt: at },
      overrides: NO_OVERRIDES
    })
    expect(row.actor_id).is.a('string')
  })

  it('keeps repeated radar packets, but never treats held fields or dashboard writes as measurements', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const phone = await publisher(worker, gameId)
    send(phone, { pitchSpeed: 88 })
    await rowCount(gameId, 1)
    clock += 1000
    send(phone, { pitchSpeed: 88 })
    await rowCount(gameId, 2)
    clock += 1000
    send(phone, { exitVelocity: 99 })
    await rowCount(gameId, 3)
    send(phone, { balls: 1 })
    const found = await rowCount(gameId, 4)
    expect(found.map(r => r.radar)).deep.equals([
      { pitchSpeed: 88 },
      { pitchSpeed: 88 },
      { exitVelocity: 99 },
      null
    ])
    expect(found[2].publisher.state.pitchSpeed).equals(88)
  })

  it('carries a timed exit reading across workers, updates and reconnects, and reconstructs it on the video clock', async () => {
    const origin = await startWorker()
    const viewerWorker = await startWorker()
    const gameId = await newGame()
    const phone = await publisher(origin, gameId)
    const board = connect(`${viewerWorker.url}/${gameId}/socket`)
    const timeline = connect(
      `${viewerWorker.url}/${gameId}/socket?timeline=1`,
      runner
    )
    await Promise.all([board.opened, timeline.opened])
    await until('initial board', () => board.messages.length > 0)
    const t0 = clock
    const sequence = [
      { after: 0, packet: { exitVelocity: 55 }, onset: 0, latest: 0, mph: 55 },
      {
        after: 250,
        packet: { exitVelocity: 56 },
        onset: 0,
        latest: 250,
        mph: 56
      },
      {
        after: 3000,
        packet: { exitVelocity: 56 },
        onset: 0,
        latest: 3000,
        mph: 56
      },
      {
        after: 4500,
        packet: { pitchSpeed: 70 },
        onset: 0,
        latest: 3000,
        mph: 56
      },
      {
        after: 8001,
        packet: { exitVelocity: 77 },
        onset: 8001,
        latest: 8001,
        mph: 77
      }
    ]
    const proof = []
    for (const { after, packet, onset, latest, mph } of sequence) {
      clock = t0 + after
      const count = board.messages.length
      send(phone, packet)
      await until('updated viewer', () => board.messages.length > count)
      await rowCount(gameId, proof.length + 1)
      const { exitReading, serverNow } = board.messages.at(-1)
      const reading = { mph, startedAt: t0 + onset, receivedAt: t0 + latest }
      expect(exitReading).deep.equals(reading)
      expect(serverNow).equals(clock)
      const historical = (await computeBoardTimeline(db, gameId))!.steps.at(-1)!
      expect(historical.state.exitReading).deep.equals(reading)
      expect(historical.state).not.to.have.property('serverNow')
      proof.push({
        publisher: packet,
        viewer: { exitReading, serverNow },
        historical: {
          at: historical.at,
          exitReading: historical.state.exitReading
        }
      })
    }
    await until('radar correction notice', () =>
      timeline.messages.some(n => n.fromMs === t0 + 8001)
    )
    clock += 10_000
    const reconnect = connect(`${viewerWorker.url}/${gameId}/socket`)
    await until('reconnected board', () => reconnect.messages.length > 0)
    expect(reconnect.messages[0]).includes({ serverNow: clock })
    expect(reconnect.messages[0].exitReading).deep.equals(
      proof.at(-1)!.viewer.exitReading
    )
    const controls = await dashboard(origin, gameId)
    send(controls, { type: 'reset' })
    await rowCount(gameId, sequence.length + 1)
    await until(
      'reset viewer',
      () => board.messages.at(-1)?.exitReading == null
    )
    expect(
      (await computeBoardTimeline(db, gameId))!.steps.at(-1)!.state
    ).not.to.have.property('exitReading')
    if (process.env.SCOREBOARD_EXIT_PROOF === '1') {
      for (const exchange of proof) console.log(JSON.stringify(exchange))
    }
  })

  it('announces a committed exit reading when refreshing the scored pitch fails', async () => {
    let failRefresh = false
    const brokenRefresh = new Proxy(db, {
      get(target, name) {
        if (name === 'transaction' && failRefresh)
          return () => {
            throw new Error('radar refresh failed')
          }
        const value = Reflect.get(target, name)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const worker = await startWorker({ db: brokenRefresh })
    const announce = worker.store.announceTimeline
    worker.store.announceTimeline = async (gameId, fromMs) => {
      await announce(gameId, fromMs)
      failRefresh = true
    }
    const gameId = await newGame()
    const phone = await publisher(worker, gameId)
    const listener = connect(
      `${worker.url}/${gameId}/socket?timeline=1`,
      runner
    )
    await listener.opened
    send(phone, { exitVelocity: 55 })
    await until('timeline notice', () =>
      listener.messages.some(message => message.fromMs === clock)
    )
    await until('refresh failure', () =>
      logged.some(line =>
        line.includes('refresh radar speeds: radar refresh failed')
      )
    )
    expect(
      (await computeBoardTimeline(db, gameId))?.steps.at(-1)?.state.exitReading
        ?.mph
    ).equals(55)
  })

  it('invalidates cached playback when an earlier exit arrives without replacing newer board snapshots', async () => {
    const gameId = await newGame()
    const cache = makeBoardTimelineCache(2)
    const row = {
      gameId,
      cause: 'publisher' as const,
      actorId: null,
      overrides: NO_OVERRIDES
    }
    await logScoreboard(db, {
      ...row,
      version: 3,
      at: clock + 2000,
      publisher: {
        state: { balls: 2, exitVelocity: 88 },
        receivedAt: clock + 2000
      },
      radar: { exitVelocity: 88 }
    })
    const before = await cache.get(db, gameId)
    await logScoreboard(db, {
      ...row,
      version: 1,
      at: clock + 1000,
      publisher: {
        state: { balls: 1, exitVelocity: 77 },
        receivedAt: clock + 1000
      },
      radar: { exitVelocity: 77 }
    })
    const after = await cache.get(db, gameId)
    expect(after?.version).not.equals(before?.version)
    expect(after?.steps.map(s => s.state.balls)).deep.equals([0, 2])
    expect(after?.steps.map(s => s.state.exitReading)).deep.equals([
      { mph: 77, startedAt: clock + 1000, receivedAt: clock + 1000 },
      { mph: 88, startedAt: clock + 1000, receivedAt: clock + 2000 }
    ])
    expect(after).deep.equals(await computeBoardTimeline(db, gameId))
    await logScoreboard(db, {
      ...row,
      cause: 'reset',
      publisher: undefined,
      version: 2,
      at: clock + 1500
    })
    const reset = await cache.get(db, gameId)
    expect(reset?.version).not.equals(after?.version)
    expect(reset?.steps.map(s => s.state.exitReading)).deep.equals([
      { mph: 77, startedAt: clock + 1000, receivedAt: clock + 1000 },
      undefined,
      { mph: 88, startedAt: clock + 2000, receivedAt: clock + 2000 }
    ])
    expect(reset).deep.equals(await computeBoardTimeline(db, gameId))
  })

  it('persists a late WebSocket radar reading on the current scored pitch', async function () {
    const context = await addScorableTeams(db, {
      home: 'Comets',
      away: 'Rockets'
    })
    const gameId = await addGame(db, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id,
      startAt: new Date()
    })
    const scorer = await addPerson(db, 'publisher', {
      owns: context.teams.home.id
    })
    const worker = await startWorker()
    const phone = connect(`${worker.url}/${gameId}/publish`, scorer)
    await phone.opened
    await scoreDirectly(db, gameId, context, [{ type: 'pitch', call: 'B' }])
    clock = Date.now()
    send(phone, { pitchSpeed: 87 })
    await until('speed on scored pitch', async () => {
      const row = await db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      return (
        (row.currentPlay as any)?.playEvents?.find((p: any) => p.isPitch)
          ?.pitchData?.startSpeed === 87
      )
    })
    expect(logged).deep.equals([])
  })

  it('retains late-arriving older radar writes from another worker without duplicating a version', async function () {
    const gameId = await newGame()
    const row = {
      gameId,
      at: clock,
      cause: 'publisher' as const,
      actorId: null,
      publisher: undefined,
      overrides: NO_OVERRIDES
    }
    await logScoreboard(db, { ...row, version: 2, radar: { pitchSpeed: 82 } })
    await logScoreboard(db, { ...row, version: 1, radar: { pitchSpeed: 81 } })
    await logScoreboard(db, { ...row, version: 1, radar: { pitchSpeed: 81 } })
    expect((await rows(gameId)).map(r => r.radar)).deep.equals([
      { pitchSpeed: 81, measurementOnly: true },
      { pitchSpeed: 82 }
    ])
  })

  it('keeps cached and rebuilt timelines identical when an older measurement arrives late', async () => {
    const gameId = await newGame()
    const cache = makeBoardTimelineCache(2)
    const row = {
      gameId,
      cause: 'publisher' as const,
      actorId: null,
      overrides: NO_OVERRIDES
    }
    await logScoreboard(db, {
      ...row,
      version: 2,
      at: clock + 2000,
      publisher: {
        state: { balls: 2, pitchSpeed: 82 },
        receivedAt: clock + 2000
      },
      radar: { pitchSpeed: 82 }
    })
    const before = await cache.get(db, gameId)
    await logScoreboard(db, {
      ...row,
      version: 1,
      at: clock + 1000,
      publisher: {
        state: { balls: 1, pitchSpeed: 81 },
        receivedAt: clock + 1000
      },
      radar: { pitchSpeed: 81 }
    })
    expect((await rows(gameId))[0].radar).deep.equals({
      pitchSpeed: 81,
      measurementOnly: true
    })
    expect(await cache.get(db, gameId)).equals(before)
    expect(await computeBoardTimeline(db, gameId)).deep.equals(before)
    expect(before?.steps.some(step => step.state.balls === 1)).equals(false)
    expect(before?.steps.at(-1)?.state.balls).equals(2)
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
