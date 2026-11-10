import { createServer, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo, connect as connectTcp } from 'node:net'
import { PassThrough } from 'node:stream'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'

import { makeId } from '../../common/ids'
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
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { forgetScoreboardSettings } from '../nodeSettings'
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
    options: {
      checkMs?: number
      pingMs?: number
      speedHoldMs?: number
      db?: Kysely<Database>
    } = {}
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
  const timeline = (worker: Worker, gameId: string, who?: Person): Probe =>
    connect(`${worker.url}/${gameId}/socket?timeline=1`, {
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
    await dropPrefix('ts-test')
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
      headers: { cookie: `ts_session=${runner.token}` }
    })
    await byCookie.opened
    send(byCookie, { balls: 2 })
    await until('balls 2', () => last(watching)?.balls === 2)
    expect(byCookie.closed).equals(undefined)
  })

  it('runs a scoreboard with an API key only with game events write, and reads its timeline with read', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    const keyOf = async (permissions: string[]): Promise<Person> => {
      const token = `tsk_scoreboard_${permissions.join('_').replace(/:/g, '-')}_${gameId}`
      await db
        .insertInto('user_api_keys')
        .values({
          id: makeId('userApiKey'),
          user_id: runner.userId,
          name: 'Scoreboard key',
          token_hash: hashToken(token),
          secret_sealed: 'v1.unused',
          permissions
        })
        .execute()
      return { ...runner, token }
    }
    const reader = await keyOf(['gameEvents:read'])
    const writer = await keyOf(['gameEvents:read', 'gameEvents:write'])
    const elsewhere = await keyOf(['schedule:read'])
    expect(await closedWith(publisher(worker, gameId, reader))).equals(
      SCOREBOARD_CLOSE.notAllowed
    )
    expect(await closedWith(dashboard(worker, gameId, reader))).equals(
      SCOREBOARD_CLOSE.notAllowed
    )
    expect(await closedWith(timeline(worker, gameId, elsewhere))).equals(
      SCOREBOARD_CLOSE.notAllowed
    )
    const watching = viewer(worker, gameId)
    await heard(watching, 1)
    const running = publisher(worker, gameId, writer)
    await running.opened
    send(running, { balls: 3 })
    await until('balls 3', () => last(watching)?.balls === 3)
    const reading = timeline(worker, gameId, reader)
    await reading.opened
    expect(reading.closed).equals(undefined)
  })

  it('admits a timeline socket only for somebody signed in who can see the game, and a plain viewer for anybody', async function () {
    const worker = await startWorker()
    const gameId = await newGame()
    expect(await closedWith(timeline(worker, gameId))).equals(
      SCOREBOARD_CLOSE.notSignedIn
    )
    expect(await closedWith(timeline(worker, gameId, stranger))).equals(
      SCOREBOARD_CLOSE.notAllowed
    )
    expect(stranger.token).not.equals(runner.token)

    // A member is admitted by token, and a browser by its cookie.
    const byToken = timeline(worker, gameId, runner)
    const byCookie = connect(`${worker.url}/${gameId}/socket?timeline=1`, {
      headers: { cookie: `ts_session=${runner.token}` }
    })
    await Promise.all([byToken.opened, byCookie.opened])
    await until('both to hear a notice', async () => {
      await worker.store.announceTimeline(gameId)
      await new Promise(resolve => setTimeout(resolve, 20))
      return byToken.messages.length > 0 && byCookie.messages.length > 0
    })
    expect(byToken.messages[0]).deep.equals({ type: 'changed' })
    expect(byToken.closed).equals(undefined)
    expect(byCookie.closed).equals(undefined)

    // The plain viewer needs no sign-in, and is sent the board as before.
    const plain = viewer(worker, gameId)
    const [board] = await heard(plain, 1)
    expect(board).includes({ homeTeam: 'Pioneers', awayTeam: 'Visitors' })
  })

  it('ends a timeline socket whose session is signed out, or who can no longer see the game', async function () {
    const worker = await startWorker({ checkMs: 50 })
    // Long past its start, so the board has closed: only the timeline stays.
    const gameId = await newGame(new Date(Date.now() - 4 * HOUR))
    const leaving = await addPerson(db, 'leaving', { owns: away })
    const signingOut = await addPerson(db, 'signingOut', { owns: away })
    const left = timeline(worker, gameId, leaving)
    const out = timeline(worker, gameId, signingOut)
    const staying = timeline(worker, gameId, runner)
    await Promise.all([left.opened, out.opened, staying.opened])
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(left.closed).equals(undefined)
    expect(out.closed).equals(undefined)

    await db
      .deleteFrom('memberships')
      .where('user_id', '=', leaving.userId)
      .execute()
    await db
      .deleteFrom('auth_sessions')
      .where('user_id', '=', signingOut.userId)
      .execute()
    expect(await closedWith(left)).equals(SCOREBOARD_CLOSE.notAllowed)
    expect(await closedWith(out)).equals(SCOREBOARD_CLOSE.notSignedIn)
    expect(staying.closed).equals(undefined)
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

  it('keeps a pitch speed for the hold, then broadcasts 0', async function () {
    const worker = await startWorker({ speedHoldMs: 80 })
    const gameId = await newGame()
    const watching = viewer(worker, gameId)
    await heard(watching, 1)
    const phone = publisher(worker, gameId, runner)
    await phone.opened
    send(phone, { pitchSpeed: 91 })
    await until('91 mph', () => last(watching)?.pitchSpeed === 91)
    await new Promise(resolve => setTimeout(resolve, 50))
    // The same number starts the hold over, so this is still 91 past the
    // first deadline.
    send(phone, { pitchSpeed: 91 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(last(watching).pitchSpeed).equals(91)
    send(phone, { pitchSpeed: 88 })
    await until('88 mph', () => last(watching)?.pitchSpeed === 88)
    phone.socket.close()
    await until('cleared', () => last(watching)?.pitchSpeed === 0)
    const cleared = watching.messages.length
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(last(watching).pitchSpeed).equals(0)
    expect(watching.messages).has.length(cleared)
  })

  it("holds a pitch speed for the node's setting when no hold is given", async function () {
    await db
      .insertInto('system_settings')
      .values({ key: 'scoreboard.speedHoldSec', value: JSON.stringify(0.2) })
      .onConflict(oc =>
        oc.column('key').doUpdateSet({ value: JSON.stringify(0.2) })
      )
      .execute()
    forgetScoreboardSettings()
    try {
      const worker = await startWorker()
      const gameId = await newGame()
      const watching = viewer(worker, gameId)
      await heard(watching, 1)
      const phone = publisher(worker, gameId, runner)
      await phone.opened
      // The hub reads the setting as it starts; give that a moment.
      await new Promise(resolve => setTimeout(resolve, 100))
      const sent = Date.now()
      send(phone, { pitchSpeed: 77 })
      await until('77 mph', () => last(watching)?.pitchSpeed === 77)
      await until('cleared', () => last(watching)?.pitchSpeed === 0)
      // Well short of the 5 s default.
      expect(Date.now() - sent).lessThan(2000)
    } finally {
      await db
        .deleteFrom('system_settings')
        .where('key', '=', 'scoreboard.speedHoldSec')
        .execute()
      forgetScoreboardSettings()
    }
  })

  it('a publisher zero cancels the pitch-speed hold', async function () {
    const worker = await startWorker({ speedHoldMs: 80 })
    const gameId = await newGame()
    const watching = viewer(worker, gameId)
    await heard(watching, 1)
    const phone = publisher(worker, gameId, runner)
    await phone.opened
    send(phone, { pitchSpeed: 70 })
    await until('70 mph', () => last(watching)?.pitchSpeed === 70)
    send(phone, { pitchSpeed: 0 })
    await until('publisher zero', () => last(watching)?.pitchSpeed === 0)
    const cleared = watching.messages.length
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(watching.messages).has.length(cleared)
  })

  it('logs a pitch-speed zero it could not write', async function () {
    const worker = await startWorker({ speedHoldMs: 80 })
    // Only the hold's zero fails, so the 91 goes through whenever the hold
    // runs out.
    const merge = worker.store.mergeWatcher
    worker.store.mergeWatcher = async (gameId, update, startAt) => {
      if (update.pitchSpeed === 0) throw new Error('the zero went nowhere')
      return await merge(gameId, update, startAt)
    }
    const gameId = await newGame()
    const watching = viewer(worker, gameId)
    await heard(watching, 1)
    const phone = publisher(worker, gameId, runner)
    await phone.opened
    send(phone, { pitchSpeed: 91 })
    await until('91 mph', () => last(watching)?.pitchSpeed === 91)
    await until('the failed zero to be logged', () =>
      logged.some(line => line.includes(`scoreboard ${gameId}: pitch speed: `))
    )
    expect(last(watching).pitchSpeed).equals(91)
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
    // TS Watcher's count is newer than the game's, so it shows.
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
    const list = await a.client.sendCommand(['CLIENT', 'LIST'])
    const id = (typeof list === 'string' ? list : '')
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

  it('tells a timeline socket its timeline may have changed after its subscriber reconnects', async function () {
    const a = await startWorker()
    const gameId = await newGame()
    const probe = timeline(a, gameId, runner)
    await probe.opened
    // A notice it hears says it has joined its game.
    await until('the socket to join its game', async () => {
      await a.store.announceTimeline(gameId)
      await new Promise(resolve => setTimeout(resolve, 20))
      return probe.messages.length > 0
    })
    // Every notice sent so far has landed before counting them.
    await new Promise(resolve => setTimeout(resolve, 200))
    const joined = probe.messages.length
    const name = `${prefix.replace(':', '-')}-0`
    const list = await a.client.sendCommand(['CLIENT', 'LIST'])
    const id = (typeof list === 'string' ? list : '')
      .split('\n')
      .find(line => line.includes(` name=${name} `))
      ?.match(/^id=(\d+)/)?.[1]
    expect(id, name).is.a('string')
    // The notice goes out while A's subscriber is gone, so A never hears it:
    // the reconnect tells the socket instead.
    await Promise.all([
      a.client.sendCommand(['CLIENT', 'KILL', 'ID', id ?? '']),
      a.store.announceTimeline(gameId)
    ])
    await heard(probe, joined + 1)
    expect(probe.messages.at(-1)).deep.equals({ type: 'changed' })
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
    // The hold is fixed so the hub reads no setting from the broken store:
    // only the sockets' own lookups are counted.
    const worker = await startWorker({ db: broken, speedHoldMs: 5000 })
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
