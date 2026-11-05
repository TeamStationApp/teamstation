import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'
import { type WebSocket, WebSocketServer } from 'ws'

import { GAME_SOCKET_PROTOCOL } from '../../src/common/gameSocket'
import { COALESCE_MS } from '../../src/common/screenScope'
import { Tally } from './actors'
import type { SeededAccount, SeededGame } from './fixture'
import {
  SCOPE_TURN,
  ScreenWatcher,
  screenRoutes,
  screenWatchers,
  screenWatchersFor
} from './screenWatcher'

const waitFor = async (
  check: () => boolean,
  timeoutMs = 10_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise(resolve => {
      setTimeout(resolve, 10)
    })
  }
}

const settle = async (ms = 100): Promise<void> => {
  await new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

const HOME = [
  '/events?played=1&limit=1',
  '/live',
  '/teams',
  '/seasons',
  '/me/groups',
  '/me/follows'
]

/** The gate's window for these watchers: short, so the runs are. */
const WINDOW_MS = 300

/**
 * A server with only what a watcher touches: a socket that answers a scope's
 * subscribe, and routes that answer `[]`, after a delay the test sets, or
 * with the status it sets.
 */
describe('a screen watcher, against a stub server', function () {
  this.timeout(30_000)

  let http: Server
  let base: string
  const sockets: WebSocket[] = []
  const subscribes: Array<Record<string, unknown>> = []
  const reads: string[] = []
  /** When each read arrived, in ms from the start of the test. */
  const readAt: number[] = []
  let started = 0
  let answer: (frame: Record<string, unknown>, ws: WebSocket) => void
  let routeDelayMs = 0
  let routeStatus = 200

  const subscribed = (frame: Record<string, unknown>, ws: WebSocket): void => {
    ws.send(
      JSON.stringify({ type: 'subscribed', scope: frame.scope, id: frame.id })
    )
  }

  before(async function () {
    http = createServer((req, res) => {
      reads.push(req.url!.replace(/^\/api\/v1/, ''))
      readAt.push(performance.now() - started)
      setTimeout(() => {
        res.writeHead(routeStatus, { 'content-type': 'application/json' })
        res.end(routeStatus === 200 ? '[]' : '{"error":"no"}')
      }, routeDelayMs)
    })
    const wss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (req, socket, head) => {
      if (req.headers.authorization !== 'Bearer good') {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, socket, head, ws => {
        sockets.push(ws)
        ws.on('message', data => {
          const frame = JSON.parse(String(data)) as Record<string, unknown>
          subscribes.push(frame)
          answer(frame, ws)
        })
      })
    })
    await new Promise<void>(resolve => {
      http.listen(0, '127.0.0.1', resolve)
    })
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  })
  after(async function () {
    for (const ws of sockets) ws.terminate()
    await new Promise(resolve => {
      http.close(resolve)
      http.closeAllConnections()
    })
  })
  beforeEach(function () {
    subscribes.length = 0
    reads.length = 0
    readAt.length = 0
    started = performance.now()
    answer = subscribed
    routeDelayMs = 0
    routeStatus = 200
  })

  const account = { token: 'good', kind: 'viewer' } as const
  const latest = (): WebSocket => sockets[sockets.length - 1]
  /** A watcher on the stub, its gate's window `WINDOW_MS`. */
  const watcherOf = (
    scope: 'home' | 'schedule' | 'event',
    tally: Tally,
    gameId = 'gam_one'
  ): ScreenWatcher =>
    new ScreenWatcher(base, account, scope, gameId, tally, {
      coalesceMs: WINDOW_MS
    })
  const send = (frame: Record<string, unknown>): void => {
    latest().send(JSON.stringify(frame))
  }

  it('reads each scope’s routes once the subscribe is answered, untimed', async function () {
    for (const [scope, routes] of [
      ['home', HOME],
      ['schedule', ['/events']],
      ['event', ['/games/gam_one']]
    ] as const) {
      reads.length = 0
      const tally = new Tally()
      const watcher = new ScreenWatcher(base, account, scope, 'gam_one', tally)
      watcher.start()
      await waitFor(() => tally.requests.length === routes.length)
      expect([...reads].sort()).deep.equals([...routes].sort())
      expect(tally.requests.map(row => row.route).sort()).deep.equals(
        routes
          .map(
            route =>
              `screen:${scope} GET ${scope === 'event' ? '/games/:id' : route}`
          )
          .sort()
      )
      expect(tally.requests.every(row => row.accountKind === 'viewer')).equals(
        true
      )
      expect(tally.screenWatchers).equals(1)
      expect(tally.screenReReads).equals(0)
      expect(tally.screenReadMs).deep.equals([])
      await watcher.stop()
    }
    expect(subscribes.slice(-1)[0]).deep.equals({
      type: 'subscribe',
      scope: 'event',
      gameId: 'gam_one',
      id: 'w1',
      protocol: GAME_SOCKET_PROTOCOL
    })
    expect(subscribes[0]).deep.equals({
      type: 'subscribe',
      scope: 'home',
      id: 'w1',
      protocol: GAME_SOCKET_PROTOCOL
    })
  })

  it('holds its reads to the app’s window unless told another', function () {
    const tally = new Tally()
    const watcher = new ScreenWatcher(base, account, 'home', 'g', tally)
    const gate = (watcher as unknown as { gate: { coalesceMs: number } }).gate
    expect(gate.coalesceMs).equals(COALESCE_MS)
  })

  it('reads a notice of its scope at once when idle, and none of another; no revision is needed', async function () {
    const tally = new Tally()
    const watcher = watcherOf('event', tally)
    watcher.start()
    await waitFor(() => reads.length === 1)
    send({ type: 'changed', scope: 'event', gameId: 'gam_two' })
    send({ type: 'changed', scope: 'home' })
    await settle(WINDOW_MS + 50)
    expect(reads.length).equals(1)
    expect(tally.screenNotices).equals(0)
    send({ type: 'changed', scope: 'event', gameId: 'gam_one' })
    await waitFor(() => tally.screenReReads === 1)
    expect(reads).deep.equals(['/games/gam_one', '/games/gam_one'])
    expect(tally.screenNotices).equals(1)
    expect(tally.screenReadMs.length).equals(1)
    expect(tally.screenReadMs[0]).above(0).and.below(WINDOW_MS)
    expect(tally.errors['screen-malformed']).equals(undefined)
    await watcher.stop()
  })

  it('reads every route on a resync, once subscribed again', async function () {
    const tally = new Tally()
    const watcher = watcherOf('home', tally)
    watcher.start()
    await waitFor(() => reads.length === HOME.length)
    send({ type: 'resync' })
    await waitFor(() => tally.screenReReads === 1)
    expect(reads.slice(HOME.length).sort()).deep.equals([...HOME].sort())
    expect(tally.screenNotices).equals(1)
    expect(tally.screenReadMs.length).equals(1)
    expect(subscribes.map(frame => frame.id)).deep.equals(['w1', 'w2'])
    await settle(WINDOW_MS + 50)
    expect(reads.length).equals(HOME.length * 2)
    await watcher.stop()
  })

  it('times the read after a resync from its subscribed, not a notice the gate dropped before it', async function () {
    const tally = new Tally()
    const watcher = watcherOf('schedule', tally)
    watcher.start()
    await waitFor(() => reads.length === 1)
    let held: { frame: Record<string, unknown>; ws: WebSocket } | undefined
    answer = (frame, ws) => {
      held = { frame, ws }
    }
    send({ type: 'resync' })
    await waitFor(() => held != null)
    // Heard before the acknowledgement: the gate drops it.
    send({ type: 'changed', scope: 'schedule' })
    await settle(WINDOW_MS + 200)
    expect(reads.length).equals(1)
    subscribed(held!.frame, held!.ws)
    await waitFor(() => tally.screenReReads === 1)
    expect(tally.screenNotices).equals(2)
    expect(tally.screenReadMs[0]).below(WINDOW_MS)
    await watcher.stop()
  })

  it('forgets when a notice came once the connection closes, as the reconnect’s subscribed reads it', async function () {
    const tally = new Tally()
    const watcher = watcherOf('schedule', tally)
    watcher.start()
    await waitFor(() => reads.length === 1)
    // Owed a read, the window not yet passed, when the connection goes.
    send({ type: 'changed', scope: 'schedule' })
    await settle(20)
    latest().terminate()
    await waitFor(() => tally.errors['screen-close-1006'] === 1)
    // The owed read runs before the reconnect, then the new subscribed's.
    await waitFor(() => tally.screenReReads === 2, 5000)
    expect(tally.screenNotices).equals(1)
    for (const ms of tally.screenReadMs) expect(ms).below(WINDOW_MS / 2)
    await watcher.stop()
  })

  it('reads once for every notice during a read, a window after it began, timed from the first', async function () {
    const tally = new Tally()
    const watcher = watcherOf('schedule', tally)
    watcher.start()
    await waitFor(() => tally.requests.length === 1)
    await settle(WINDOW_MS)
    routeDelayMs = 150
    send({ type: 'changed', scope: 'schedule' })
    await waitFor(() => reads.length === 2)
    for (let i = 0; i < 10; i++) send({ type: 'changed', scope: 'schedule' })
    await waitFor(() => tally.screenReReads === 2)
    await settle(WINDOW_MS + 100)
    expect(reads.length).equals(3)
    expect(tally.screenNotices).equals(11)
    // The third read began a window after the second, not at once.
    expect(readAt[2] - readAt[1]).at.least(WINDOW_MS - 20)
    // Timed from the first notice it covers.
    expect(tally.screenReadMs[1]).at.least(WINDOW_MS)
    await watcher.stop()
  })

  it('holds a notice soon after a read to the window, and reads one after it at once', async function () {
    const tally = new Tally()
    const watcher = watcherOf('schedule', tally)
    watcher.start()
    await waitFor(() => reads.length === 1)
    send({ type: 'changed', scope: 'schedule' })
    await settle(WINDOW_MS / 3)
    expect(reads.length).equals(1)
    await waitFor(() => reads.length === 2)
    expect(readAt[1] - readAt[0]).at.least(WINDOW_MS - 20)
    await settle(WINDOW_MS + 50)
    const before = performance.now() - started
    send({ type: 'changed', scope: 'schedule' })
    await waitFor(() => reads.length === 3)
    expect(readAt[2] - before).below(WINDOW_MS / 2)
    await watcher.stop()
  })

  it('reads again on the resubscribe after a lost connection', async function () {
    const tally = new Tally()
    const watcher = watcherOf('schedule', tally)
    watcher.start()
    await waitFor(() => reads.length === 1)
    latest().terminate()
    await waitFor(() => subscribes.length === 2, 5000)
    await waitFor(() => reads.length === 2)
    expect(tally.errors['screen-close-1006']).equals(1)
    expect(tally.socketsOpened).equals(2)
    expect(tally.screenWatchers).equals(1)
    await waitFor(() => tally.screenReReads === 1)
    await watcher.stop()
  })

  it('counts what goes wrong by kind, and stops reading when stopped', async function () {
    const refused = new Tally()
    const outsider = new ScreenWatcher(
      base,
      { token: 'bad', kind: 'viewer' },
      'home',
      'g',
      refused
    )
    outsider.start()
    await waitFor(() => (refused.errors['screen-http-401'] ?? 0) > 0)
    await outsider.stop()
    expect(refused.screenWatchers).equals(0)

    const nowhere = new Tally()
    const lost = new ScreenWatcher(
      'http://127.0.0.1:1',
      account,
      'home',
      'g',
      nowhere
    )
    lost.start()
    await waitFor(() => (nowhere.errors.unreachable ?? 0) > 0)
    await lost.stop()

    answer = (frame, ws) => {
      ws.send(
        JSON.stringify({
          type: 'error',
          id: frame.id,
          code: 'notFound',
          message: 'no'
        })
      )
      ws.send(JSON.stringify({ type: 'error', id: 'other', code: 'x' }))
      ws.send('not json')
      ws.send(JSON.stringify({ type: 'subscribed', id: frame.id }))
      ws.send(JSON.stringify({ type: 'pong', id: 'p' }))
    }
    const tally = new Tally()
    const watcher = watcherOf('event', tally, 'gam_x')
    watcher.start()
    await waitFor(() => (tally.errors['screen-malformed'] ?? 0) === 1)
    expect(tally.errors['screen-notFound']).equals(1)
    expect(tally.errors['screen-x']).equals(undefined)
    // Refused, it reads at once, as the app's gate does, and the answer
    // after the refusal answers nothing.
    await settle(WINDOW_MS + 50)
    expect(reads).deep.equals(['/games/gam_x'])
    expect(tally.screenReReads).equals(0)

    // A route that fails is counted under its status, and still timed.
    answer = subscribed
    routeStatus = 500
    const failing = new Tally()
    const reader = new ScreenWatcher(base, account, 'schedule', 'g', failing)
    reader.start()
    await waitFor(() => (failing.errors['http-500'] ?? 0) === 1)
    expect(failing.requests.map(row => row.route)).deep.equals([
      'screen:schedule GET /events'
    ])
    await reader.stop()
    await watcher.stop()

    // A frame with no error code is counted as an error.
    answer = (frame, ws) => {
      ws.send(JSON.stringify({ type: 'error', id: frame.id }))
    }
    const bare = new Tally()
    const plain = new ScreenWatcher(base, account, 'home', 'g', bare)
    plain.start()
    await waitFor(() => (bare.errors['screen-error'] ?? 0) === 1)
    await plain.stop()

    // Stopped while a read owes another: the owed one is not made.
    answer = subscribed
    routeDelayMs = 150
    reads.length = 0
    const owing = new Tally()
    const stopping = watcherOf('schedule', owing, 'g')
    stopping.start()
    await waitFor(() => reads.length === 1)
    send({ type: 'changed', scope: 'schedule' })
    await waitFor(() => owing.screenNotices === 1)
    await stopping.stop()
    await settle(WINDOW_MS + 100)
    expect(reads.length).equals(1)
  })

  it('reads through a refusal the server may lift, and the next connection’s subscribed follows the scope again', async function () {
    answer = (frame, ws) => {
      if (frame.id === 'w1')
        ws.send(
          JSON.stringify({
            type: 'error',
            id: frame.id,
            code: 'internal',
            message: 'try again'
          })
        )
      else subscribed(frame, ws)
    }
    const tally = new Tally()
    const watcher = watcherOf('schedule', tally)
    watcher.start()
    // As a phone's gate: refused, it reads at once rather than wait.
    await waitFor(() => reads.length === 1)
    expect(tally.errors['screen-internal']).equals(1)
    expect(tally.screenReReads).equals(0)
    // While refused, a notice still reads, timed from the notice.
    await settle(WINDOW_MS + 50)
    send({ type: 'changed', scope: 'schedule' })
    await waitFor(() => tally.screenReReads === 1)
    expect(tally.screenReadMs[0]).below(WINDOW_MS)
    // The scope is held: the next connection asks for it again, and its
    // subscribed reads.
    latest().terminate()
    await waitFor(() => tally.screenReReads === 2, 5000)
    expect(subscribes.map(frame => frame.id)).deep.equals(['w1', 'w2'])
    expect(reads).deep.equals(['/events', '/events', '/events'])
    await settle(WINDOW_MS + 50)
    send({ type: 'changed', scope: 'schedule' })
    await waitFor(() => tally.screenReReads === 3)
    expect(tally.errors['screen-internal']).equals(1)
    await watcher.stop()
  })

  it('stops for good when refused as too old: no read, notice or later subscribe', async function () {
    answer = (frame, ws) => {
      ws.send(
        JSON.stringify({
          type: 'error',
          id: frame.id,
          code: 'forbidden',
          reason: 'updateRequired',
          message: 'update'
        })
      )
      // An answer after the refusal answers nothing.
      ws.send(JSON.stringify({ type: 'subscribed', id: frame.id }))
    }
    const tally = new Tally()
    const watcher = watcherOf('schedule', tally)
    watcher.start()
    await waitFor(() => tally.errors['screen-forbidden'] === 1)
    send({ type: 'changed', scope: 'schedule' })
    await settle(WINDOW_MS + 50)
    latest().terminate()
    await waitFor(() => tally.socketsOpened === 2, 5000)
    await settle(WINDOW_MS + 50)
    expect(subscribes.map(frame => frame.id)).deep.equals(['w1'])
    expect(reads).deep.equals([])
    expect(tally.errors['screen-forbidden']).equals(1)
    await watcher.stop()
  })

  it('counts a socket error that is not a refusal', async function () {
    const tally = new Tally()
    const watcher = new ScreenWatcher(base, account, 'home', 'g', tally)
    watcher.start()
    await waitFor(() => reads.length === HOME.length)
    const inner = watcher as unknown as {
      ws: { emit: (event: string, error: Error) => void }
    }
    inner.ws.emit('error', new Error('something else'))
    expect(tally.errors['screen-error']).equals(1)
    await watcher.stop()
  })
})

describe('dealing screen watchers', function () {
  const accountAt = (i: number, gameIndex: number | null): SeededAccount => ({
    label: `viewer${i}`,
    kind: 'viewer',
    userId: `usr_${i}`,
    token: `t${i}`,
    teamId: null,
    gameIndex
  })
  const gameAt = (i: number): SeededGame => ({
    id: `gam_${i}`,
    sides: {} as SeededGame['sides'],
    seasonId: 'sea_1',
    scorekeeper: 'scorer'
  })

  it('takes the scopes in turn, each on its account’s game', function () {
    const accounts = [accountAt(0, 0), accountAt(1, 1), accountAt(2, null)]
    const games = [gameAt(0), gameAt(1)]
    const dealt = screenWatchersFor(accounts, games, 7)
    expect(SCOPE_TURN).deep.equals([
      'event',
      'event',
      'home',
      'schedule',
      'home'
    ])
    expect(dealt.map(row => row.scope)).deep.equals([
      'event',
      'event',
      'home',
      'schedule',
      'home',
      'event',
      'event'
    ])
    expect(dealt.map(row => row.account.label)).deep.equals([
      'viewer0',
      'viewer1',
      'viewer2',
      'viewer0',
      'viewer1',
      'viewer2',
      'viewer0'
    ])
    expect(dealt.map(row => row.game.id)).deep.equals([
      'gam_0',
      'gam_1',
      'gam_0',
      'gam_0',
      'gam_1',
      'gam_0',
      'gam_0'
    ])
    expect(screenWatchersFor([], games, 3)).deep.equals([])
    expect(screenWatchersFor(accounts, [], 3)).deep.equals([])
    expect(screenWatchersFor(accounts, games, 0)).deep.equals([])
  })

  it('deals them over the servers, and names each scope’s routes', function () {
    const watchers = screenWatchers(
      ['http://a.example.test', 'http://b.example.test'],
      [accountAt(0, 0)],
      [gameAt(0)],
      3,
      new Tally()
    )
    expect(
      watchers.map(watcher => [
        watcher.scope,
        (watcher as unknown as { server: string }).server
      ])
    ).deep.equals([
      ['event', 'http://a.example.test'],
      ['event', 'http://b.example.test'],
      ['home', 'http://a.example.test']
    ])
    expect(screenRoutes('event', 'gam_9')).deep.equals([
      { path: '/games/gam_9', route: '/games/:id' }
    ])
    expect(screenRoutes('schedule', 'gam_9')).deep.equals([
      { path: '/events', route: '/events' }
    ])
    expect(screenRoutes('home', 'gam_9').map(row => row.path)).deep.equals(HOME)
  })
})
