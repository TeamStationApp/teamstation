import { createServer, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo, connect as connectTcp } from 'node:net'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'

import {
  NO_OVERRIDES,
  SCOREBOARD_CLOSE,
  type ScoreboardState
} from '../../common/scoreboard'
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
import { makeScoreboardHub, type ScoreboardHub } from './scoreboardHub'
import {
  makeScoreboardStore,
  makeScoreboardSubscriber,
  type ScoreboardClient,
  type ScoreboardStore
} from './scoreboardStore'

/**
 * The hub through `attachScoreboard` on real HTTP servers and a real Redis.
 * Two hubs, each with its own Redis connections, stand in for two workers.
 */

const HOUR = 3_600_000

interface Worker {
  url: string
  port: number
  hub: ScoreboardHub
  store: ScoreboardStore
  client: ScoreboardClient
  subscriber: ScoreboardClient
  close: () => Promise<void>
}

/** What one test socket heard, and how it was closed. */
interface Probe {
  socket: WebSocket
  messages: any[]
  closed?: { code: number; reason: string }
  errored?: Error
  opened: Promise<void>
}

describe('the scoreboard hub', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let prefix = ''
  /** How far the hubs' and stores' clock is ahead of the real one. */
  let offset = 0
  const now = (): number => Date.now() + offset
  let runner: Person
  let stranger: Person
  let home = ''
  let away = ''
  const workers: Worker[] = []
  const probes: Probe[] = []
  const logged: string[] = []

  async function startWorker(
    options: { checkMs?: number; pingMs?: number; db?: Kysely<Database> } = {}
  ): Promise<Worker> {
    const client = await connectedClient()
    const subscriber = makeScoreboardSubscriber(client, quiet)
    await subscriber.connect()
    // Named, so a test can find this one connection and kill it alone.
    await subscriber.clientSetName(
      `${prefix.replace(':', '-')}-${workers.length}`
    )
    const store = makeScoreboardStore({ client, prefix, now })
    const hub = makeScoreboardHub({
      db,
      store,
      subscriber,
      log: line => logged.push(line),
      now,
      ...options
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
      port,
      hub,
      store,
      client,
      subscriber,
      close: async () => {
        await close()
        server.closeAllConnections()
        server.close()
      }
    }
    workers.push(worker)
    return worker
  }

  function connect(
    url: string,
    options: { headers?: Record<string, string>; autoPong?: boolean } = {}
  ): Probe {
    const socket = new WebSocket(url, options)
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
    socket.on('close', (code, reason) => {
      probe.closed = { code, reason: String(reason) }
    })
    socket.on('error', error => {
      probe.errored = error
    })
    probes.push(probe)
    return probe
  }
  const viewer = (worker: Worker, gameId: string): Probe =>
    connect(`${worker.url}/${gameId}/socket`)
  const publisher = (worker: Worker, gameId: string, who?: Person): Probe =>
    connect(`${worker.url}/${gameId}/publish`, {
      headers: who == null ? {} : { authorization: `Bearer ${who.token}` }
    })
  const dashboard = (worker: Worker, gameId: string, who: Person): Probe =>
    connect(`${worker.url}/${gameId}/dashboard`, {
      headers: { authorization: `Bearer ${who.token}` }
    })

  async function closedWith(probe: Probe): Promise<number> {
    await until('the socket to close', () => probe.closed != null)
    return probe.closed?.code ?? 0
  }
  async function heard(probe: Probe, count: number): Promise<any[]> {
    await until(
      `${count} messages (have ${probe.messages.length})`,
      () => probe.messages.length >= count
    )
    return probe.messages
  }
  const last = (probe: Probe): ScoreboardState => probe.messages.at(-1)
  const send = (probe: Probe, value: unknown): void => {
    probe.socket.send(typeof value === 'string' ? value : JSON.stringify(value))
  }
  async function newGame(
    startAt = new Date(),
    status?: 'cancelled'
  ): Promise<string> {
    return await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt,
      status
    })
  }

  before(async function () {
    await requireRedis()
    ;({ db, drop } = await scratchDatabase('scoreboard_hub'))
    prefix = testPrefix()
    home = await addTeam(db, 'Pioneers')
    away = await addTeam(db, 'Visitors')
    runner = await addPerson(db, 'runner', { owns: home })
    stranger = await addPerson(db, 'stranger')
  })

  afterEach(async function () {
    offset = 0
    for (const probe of probes.splice(0)) probe.socket.terminate()
    for (const worker of workers.splice(0)) await worker.close()
  })

  after(async function () {
    await dropPrefix('gs-test')
    await drop?.()
  })

  it('shows a viewer the board on open, and refuses a closed or unknown game', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const open = viewer(worker, gameId)
    const [first] = await heard(open, 1)
    expect(first).includes({
      homeTeam: 'Pioneers',
      awayTeam: 'Visitors',
      balls: 0,
      inGame: false
    })
    const past = await newGame(new Date(Date.now() - 4 * HOUR))
    const cancelled = await newGame(new Date(), 'cancelled')
    for (const closed of [past, cancelled, 'gam_nothere']) {
      expect(await closedWith(viewer(worker, closed))).equals(
        SCOREBOARD_CLOSE.closed
      )
    }
  })

  it('refuses a publisher who is not signed in or does not run the game, and takes the cookie', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    expect(await closedWith(publisher(worker, gameId))).equals(
      SCOREBOARD_CLOSE.notSignedIn
    )
    expect(await closedWith(publisher(worker, gameId, stranger))).equals(
      SCOREBOARD_CLOSE.notAllowed
    )
    expect(await closedWith(dashboard(worker, gameId, stranger))).equals(
      SCOREBOARD_CLOSE.notAllowed
    )

    const watching = viewer(worker, gameId)
    await heard(watching, 1)
    const byCookie = connect(`${worker.url}/${gameId}/publish`, {
      headers: { cookie: `gs_session=${runner.token}` }
    })
    await byCookie.opened
    send(byCookie, { balls: 2 })
    await until('balls 2', () => last(watching)?.balls === 2)
    expect(byCookie.closed).equals(undefined)
  })

  it('carries a partial to every viewer, with the game’s own team names', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const one = viewer(worker, gameId)
    const two = viewer(worker, gameId)
    await heard(one, 1)
    await heard(two, 1)
    const phone = publisher(worker, gameId, runner)
    await phone.opened
    send(phone, { balls: 3, pitchSpeed: 62, homeTeam: 'WRONG' })
    for (const probe of [one, two]) {
      await heard(probe, 2)
      expect(last(probe)).includes({
        balls: 3,
        pitchSpeed: 62,
        homeTeam: 'Pioneers'
      })
      expect(probe.messages.map(state => state.homeTeam)).not.includes('WRONG')
    }
  })

  it('delivers a burst of 50 to viewers on two workers, all of them, in order', async function () {
    const a = await startWorker()
    const b = await startWorker()
    const gameId = await newGame()
    const onA = viewer(a, gameId)
    const onB = viewer(b, gameId)
    await heard(onA, 1)
    await heard(onB, 1)
    const phone = publisher(a, gameId, runner)
    await phone.opened
    for (let i = 0; i < 50; i++) send(phone, { numPitches: i })
    // One that opens during the burst gets a first state, then only newer.
    await until('a few', () => onA.messages.length > 10)
    const late = viewer(b, gameId)
    for (const probe of [onA, onB]) {
      const got = await heard(probe, 51)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(probe.messages).has.length(51)
      expect(got.slice(1).map(state => state.numPitches)).deep.equals(
        Array.from({ length: 50 }, (_, i) => i)
      )
    }
    await until(
      'the late viewer to catch up',
      () => last(late)?.numPitches === 49
    )
    const pitches = late.messages.map(state => state.numPitches as number)
    for (let i = 1; i < pitches.length; i++) {
      expect(pitches[i], pitches.join(',')).is.above(pitches[i - 1])
    }
    expect(
      (await a.store.readScoreboard(gameId))?.watcher?.state.numPitches
    ).equals(49)
  })

  it('skips a message no newer than what a socket has, and survives a lost or older version', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const probe = viewer(worker, gameId)
    await heard(probe, 1)
    const written = await worker.store.mergeWatcher(
      gameId,
      { balls: 1 },
      Date.now()
    )
    await heard(probe, 2)
    if (written.kind !== 'written') throw new Error(written.kind)
    // The same state again, and an older one: neither is sent.
    for (const version of [written.message.version, 1]) {
      await worker.client.publish(
        worker.store.channel,
        JSON.stringify({
          ...written.message,
          version: String(version),
          watcher: { ...written.message.watcher, state: { balls: 0 } }
        })
      )
    }
    // The key goes, and comes back: above the old version, and sent.
    await worker.client.del(worker.store.keyOf(gameId))
    offset = 5
    await worker.store.mergeWatcher(gameId, { balls: 2 }, Date.now())
    await until('balls 2', () => last(probe)?.balls === 2)
    // Redis back from an older snapshot: a lower version on the same key.
    await worker.client.hSet(worker.store.keyOf(gameId), 'version', '3')
    offset = 10
    await worker.store.mergeWatcher(gameId, { balls: 3 }, Date.now())
    await until('balls 3', () => last(probe)?.balls === 3)
    expect(probe.messages.map(state => state.balls)).deep.equals([0, 1, 2, 3])
  })

  it('keeps the newer game state when two game writes finish out of order', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const probe = viewer(worker, gameId)
    await heard(probe, 1)
    // A write from outside the hub, as the play-post hook makes.
    await worker.store.writeGame(gameId, { balls: 2 }, Date.now(), 200)
    await until('balls 2', () => last(probe)?.balls === 2)
    expect(
      await worker.store.writeGame(gameId, { balls: 1 }, Date.now(), 100)
    ).deep.equals({ kind: 'stale' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(last(probe).balls).equals(2)
  })

  it('lets the dashboard override the count, and reset the game state', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    await worker.store.writeGame(gameId, { balls: 1 }, Date.now(), 1)
    const probe = viewer(worker, gameId)
    const board = dashboard(worker, gameId, runner)
    await heard(probe, 1)
    const [state] = await heard(board, 1)
    expect(state).includes({ type: 'state', watcherAt: null })
    expect(state.automated.balls).equals(1)
    expect(state.gameAt).is.a('number')
    // GS Watcher's count is newer than the game's, so it shows.
    const phone = publisher(worker, gameId, runner)
    await phone.opened
    send(phone, { balls: 3 })
    await until('the watcher’s 3-0', () => last(probe)?.balls === 3)
    send(board, {
      type: 'overrides',
      data: {
        ...NO_OVERRIDES,
        overrideCountEnabled: true,
        overrideCount: { balls: 0, strikes: 2, outs: 0 }
      }
    })
    await until('0-2', () => last(probe)?.strikes === 2)
    expect(last(probe).balls).equals(0)
    await until('the dashboard hears it', () =>
      board.messages.some(message => message.final.strikes === 2)
    )
    send(board, { type: 'reset' })
    // Reset drops the watcher's state as well as the overrides, so the board
    // falls back to the game's own 1-0.
    await until('back to 1-0', () => last(probe)?.balls === 1)
    expect(last(probe).strikes).equals(0)
    expect(
      await worker.client.hGet(worker.store.keyOf(gameId), 'watcher')
    ).equals(null)
    await until('the dashboard hears the reset', () =>
      board.messages.some(
        message => message.watcherAt === null && message.final?.balls === 1
      )
    )
    expect(board.messages.at(-1)).deep.includes({
      overrides: NO_OVERRIDES,
      watcherAt: null
    })
    expect(board.messages.at(-1).automated.balls).equals(1)
    send(board, { type: 'overrides', data: { balls: 1 } })
    await until('an error', () =>
      board.messages.some(message => message.error != null)
    )
    expect(board.closed).equals(undefined)
  })

  it('answers unreadable messages with an error and keeps the socket', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const probe = viewer(worker, gameId)
    await heard(probe, 1)
    const phone = publisher(worker, gameId, runner)
    await phone.opened
    send(phone, '{not json')
    send(phone, { balls: 'three' })
    send(phone, { balls: 3 })
    await until('two errors', () => phone.messages.length >= 2)
    expect(phone.messages[0]).deep.equals({ error: 'That message is not JSON' })
    expect(phone.messages[1].error).includes('balls')
    await until('balls 3', () => last(probe)?.balls === 3)
    expect(phone.closed).equals(undefined)
    // Inbound messages on a viewer socket are ignored.
    send(probe, { balls: 0 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(last(probe).balls).equals(3)
  })

  /**
   * Opens a socket, sends one message the moment it opens, and closes it at
   * once, so the close lands while the server is still admitting it.
   */
  async function sendAndClose(
    url: string,
    token: string,
    message: unknown
  ): Promise<void> {
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` }
    })
    socket.on('error', () => undefined)
    await new Promise<void>(resolve => {
      socket.once('open', () => {
        socket.send(JSON.stringify(message))
        socket.close(1000)
      })
      socket.once('close', () => {
        resolve()
      })
    })
  }

  it('writes what a publisher or dashboard sent although it closed while being admitted', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const read = async (): Promise<any> =>
      await worker.store.readScoreboard(gameId)
    for (let i = 1; i <= 20; i++) {
      await sendAndClose(`${worker.url}/${gameId}/publish`, runner.token, {
        numPitches: i
      })
      await until(
        `publish ${i} to be stored`,
        async () => (await read())?.watcher?.state.numPitches === i
      )
      const overrides = {
        ...NO_OVERRIDES,
        overrideInningEnabled: true,
        overrideInning: { inning: i, half: 'top' as const }
      }
      await sendAndClose(`${worker.url}/${gameId}/dashboard`, runner.token, {
        type: 'overrides',
        data: overrides
      })
      await until(
        `override ${i} to be stored`,
        async () => (await read())?.overrides?.overrideInning?.inning === i
      )
    }
    // Refused ones write nothing: a stranger, and a token nobody holds.
    for (const token of [stranger.token, 'not-a-session']) {
      await sendAndClose(`${worker.url}/${gameId}/publish`, token, {
        numPitches: 99
      })
      await sendAndClose(`${worker.url}/${gameId}/dashboard`, token, {
        type: 'overrides',
        data: {
          ...NO_OVERRIDES,
          overrideInningEnabled: true,
          overrideInning: { inning: 99, half: 'top' }
        }
      })
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    const after = await read()
    expect(after?.watcher?.state.numPitches).equals(20)
    expect(after?.overrides?.overrideInning?.inning).equals(20)
    expect(logged.filter(line => line.includes(gameId))).deep.equals([])
  })

  it('closes a publisher whose write finds the scoreboard closed', async function () {
    const worker = await startWorker()
    const gameId = await newGame(new Date(Date.now() - HOUR))
    const phone = publisher(worker, gameId, runner)
    await phone.opened
    await new Promise(resolve => setTimeout(resolve, 50))
    offset = HOUR + 1000
    send(phone, { balls: 1 })
    expect(await closedWith(phone)).equals(SCOREBOARD_CLOSE.closed)
  })

  it('sends the current state again after its subscriber reconnects', async function () {
    const a = await startWorker()
    const gameId = await newGame()
    const probe = viewer(a, gameId)
    await heard(probe, 1)
    const name = `${prefix.replace(':', '-')}-0`
    const id = (await a.client.sendCommand(['CLIENT', 'LIST']))
      .split('\n')
      .find(line => line.includes(` name=${name} `))
      ?.match(/^id=(\d+)/)?.[1]
    expect(id, name).is.a('string')
    // The kill and the write go out together on one connection, so Redis
    // publishes while A's subscriber is gone: A misses the message.
    await Promise.all([
      a.client.sendCommand(['CLIENT', 'KILL', 'ID', id ?? '']),
      a.store.mergeWatcher(gameId, { outs: 2 }, Date.now())
    ])
    await until('outs 2 after the reconnect', () => last(probe)?.outs === 2)
  })

  it('closes the sockets of a game whose board has expired', async function () {
    const worker = await startWorker({ checkMs: 50 })
    const gameId = await newGame(new Date(Date.now() - HOUR))
    const probe = viewer(worker, gameId)
    await heard(probe, 1)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(probe.closed).equals(undefined)
    offset = HOUR + 1000
    expect(await closedWith(probe)).equals(SCOREBOARD_CLOSE.closed)
  })

  it('drops a socket that stops answering pings, and closes with 1001', async function () {
    const worker = await startWorker({ pingMs: 50 })
    const gameId = await newGame()
    const deaf = connect(`${worker.url}/${gameId}/socket`, { autoPong: false })
    const alive = viewer(worker, gameId)
    await heard(alive, 1)
    expect(await closedWith(deaf)).equals(1006)
    expect(alive.closed).equals(undefined)
    await worker.close()
    workers.splice(workers.indexOf(worker), 1)
    expect(await closedWith(alive)).equals(1001)
  })

  it('destroys an upgrade on any other path', async function () {
    const worker = await startWorker()
    const stray = connect(worker.url.replace('/scoreboard', '/elsewhere'))
    await until('an error', () => stray.errored != null)
    const bad = connect(`${worker.url}/g1/other`)
    await until('an error', () => bad.errored != null)
  })

  /** Sends one raw upgrade request and returns everything the server wrote. */
  async function rawUpgrade(worker: Worker, path: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const tcp = connectTcp(worker.port, '127.0.0.1')
      let heardText = ''
      tcp.on('data', data => {
        heardText += data.toString('latin1')
      })
      tcp.on('error', reject)
      tcp.on('close', () => {
        resolve(heardText)
      })
      tcp.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n` +
          'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      )
    })
  }

  it('answers an undecodable path with 400 and keeps serving', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    for (const kind of ['socket', 'publish', 'dashboard']) {
      expect(
        await rawUpgrade(worker, `/api/v1/scoreboard/%E0%A4%A/${kind}`)
      ).equals('HTTP/1.1 400 Bad Request\r\n\r\n')
    }
    // A target `new URL` cannot parse is destroyed, not thrown.
    expect(await rawUpgrade(worker, '//a:99999')).equals('')
    expect(logged.some(line => line.includes('Invalid URL'))).equals(true)
    const probe = viewer(worker, gameId)
    const [first] = await heard(probe, 1)
    expect(first.homeTeam).equals('Pioneers')
  })

  it('closes a socket for an id no game could have with 4404, without asking Postgres', async function () {
    let asked = 0
    const broken = new Proxy(db, {
      get: (target, name) => {
        if (name === 'selectFrom') {
          return () => {
            asked++
            throw new Error('the database fell over')
          }
        }
        return Reflect.get(target, name)
      }
    })
    const worker = await startWorker({ db: broken })
    const loggedBefore = logged.length
    for (const id of ['%00', 'gam_%01x', 'g'.repeat(65), 'gam_%2Fx']) {
      expect(await closedWith(viewer(worker, id)), id).equals(
        SCOREBOARD_CLOSE.closed
      )
      expect(await closedWith(publisher(worker, id, runner)), id).equals(
        SCOREBOARD_CLOSE.closed
      )
      expect(await closedWith(dashboard(worker, id, runner)), id).equals(
        SCOREBOARD_CLOSE.closed
      )
    }
    expect(asked).equals(0)
    expect(logged.slice(loggedBefore)).deep.equals([])
    // The longest id there could be is looked up, and here that fails.
    expect(await closedWith(viewer(worker, 'g'.repeat(64)))).equals(1011)
    expect(asked).equals(1)
  })

  it('logs and refuses a socket whose sign-in lookup throws', async function () {
    const broken = new Proxy(db, {
      get: (target, name) => {
        if (name === 'selectFrom') {
          return () => {
            throw new Error('the database fell over')
          }
        }
        return Reflect.get(target, name)
      }
    })
    const worker = await startWorker({ db: broken })
    expect(await closedWith(publisher(worker, 'gam_any', runner))).equals(1011)
    expect(logged.some(line => line.includes('the database fell over'))).equals(
      true
    )
    const probe = connect(`${worker.url}/gam_any/socket`)
    expect(await closedWith(probe)).equals(1011)
  })

  it('logs and destroys an upgrade whose request throws', async function () {
    const worker = await startWorker()
    const socket = new PassThrough()
    let destroyed = false
    socket.on('close', () => {
      destroyed = true
    })
    const req = {
      get url(): string {
        throw new Error('no url here')
      }
    } as unknown as IncomingMessage
    expect(() => {
      worker.hub.handleUpgrade(req, socket, Buffer.alloc(0))
    }).not.to.throw()
    await until('the socket to be destroyed', () => destroyed)
    expect(logged.some(line => line.includes('no url here'))).equals(true)
  })
})
