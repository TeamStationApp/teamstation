import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type ChatSocketEvent,
  GAME_SOCKET_PROTOCOL,
  GameSocket,
  type GameSocketEvent,
  RECONNECT_DELAYS_MS,
  RESUBSCRIBE_DELAYS_MS,
  type ScreenScopeEvent,
  socketUrl,
  TYPING_INTERVAL_MS,
  type WebSocketLike
} from './gameSocket'
import { userIdOfValue } from './userId'

/** A WebSocket the test opens, closes and talks through by hand. */
class FakeSocket implements WebSocketLike {
  static made: FakeSocket[] = []
  sent: unknown[] = []
  closedWith: number | undefined
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers: Record<string, string> }
  ) {
    FakeSocket.made.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(code?: number): void {
    this.closedWith = code ?? 1005
  }

  open(): void {
    this.onopen?.({})
  }

  drop(code?: number): void {
    this.onclose?.(code == null ? {} : { code })
  }

  receive(frame: unknown): void {
    this.onmessage?.({
      data: typeof frame === 'string' ? frame : JSON.stringify(frame)
    })
  }
}

/** Timers the test fires by hand, in the order they were set. */
function manualTimers(): {
  delays: number[]
  fire: () => void
  pending: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
} {
  const waiting = new Map<number, () => void>()
  const delays: number[] = []
  let next = 1
  return {
    delays,
    fire: () => {
      const [id, run] = [...waiting.entries()][0]
      waiting.delete(id)
      run()
    },
    pending: () => waiting.size,
    setTimer: (run, ms) => {
      delays.push(ms)
      const id = next++
      waiting.set(id, run)
      return id
    },
    clearTimer: timer => {
      waiting.delete(timer as number)
    }
  }
}

function makeSocket(
  options: { token?: string; baseUrl?: string; now?: () => number } = {}
): {
  socket: GameSocket
  timers: ReturnType<typeof manualTimers>
} {
  FakeSocket.made = []
  const timers = manualTimers()
  const socket = new GameSocket({
    baseUrl: options.baseUrl ?? 'http://api.test:9100/api/v1',
    token: options.token,
    WebSocketImpl: FakeSocket,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: options.now
  })
  return { socket, timers }
}

const last = (): FakeSocket => FakeSocket.made[FakeSocket.made.length - 1]

/** U16: the shared client, against a fake WebSocket. */
describe('GameSocket (U16)', function () {
  describe('its address', function () {
    it('turns http into ws and https into wss, on the same host and port', function () {
      expect(socketUrl('http://192.168.7.40:9100/api/v1')).equals(
        'ws://192.168.7.40:9100/socket'
      )
      expect(socketUrl('https://app.teamstation.app/api/v1/')).equals(
        'wss://app.teamstation.app/socket'
      )
    })

    it('resolves a relative base against the page', function () {
      expect(
        socketUrl('/api/v1', 'https://app.teamstation.app/games/g1?tab=watch')
      ).equals('wss://app.teamstation.app/socket')
      expect(socketUrl('/api/v1', 'http://localhost:8092/')).equals(
        'ws://localhost:8092/socket'
      )
    })

    it('throws for a relative base with no page, or a base that is not http', function () {
      expect(() => socketUrl('/api/v1')).throws(/relative/)
      expect(() => socketUrl('ftp://example.com/api')).throws(/not an http/)
      // Made, it fails only when it would connect, before keeping anything.
      const socket = new GameSocket({
        baseUrl: '/api/v1',
        pageHref: undefined,
        WebSocketImpl: FakeSocket
      })
      expect(() => socket.subscribe('g1', () => undefined)).throws(/relative/)
      expect(() => socket.url).throws(/relative/)
    })

    it('reads the page from location, and WebSocket from the platform', function () {
      const world = globalThis as {
        location?: unknown
        WebSocket?: unknown
      }
      const had = { location: world.location, WebSocket: world.WebSocket }
      try {
        Object.defineProperty(globalThis, 'location', {
          value: { href: 'https://app.teamstation.app/' },
          configurable: true,
          writable: true
        })
        Object.defineProperty(globalThis, 'WebSocket', {
          value: undefined,
          configurable: true,
          writable: true
        })
        const socket = new GameSocket({ baseUrl: '/api/v1' })
        expect(() => socket.subscribe('g1', () => undefined)).throws(
          /no WebSocket/
        )
        world.WebSocket = FakeSocket
        expect(socket.url).equals('wss://app.teamstation.app/socket')
        socket.subscribe('g1', () => undefined)
        expect(last().url).equals('wss://app.teamstation.app/socket')
        socket.close()
      } finally {
        world.location = had.location
        world.WebSocket = had.WebSocket
      }
    })
  })

  describe('connecting', function () {
    it('connects on the first subscribe, and sends the bearer header when it has a token', function () {
      const { socket } = makeSocket({ token: 'tok_phone' })
      expect(FakeSocket.made).lengthOf(0)
      socket.subscribe('g1', () => undefined)
      expect(FakeSocket.made).lengthOf(1)
      expect(last().options).deep.equals({
        headers: { Authorization: 'Bearer tok_phone' }
      })
      socket.close()
    })

    it('sends no headers on the web, where the cookie goes by itself', function () {
      const { socket } = makeSocket()
      socket.subscribe('g1', () => undefined)
      expect(last().options).equals(undefined)
      expect(last().protocols).equals(undefined)
      socket.close()
    })

    it('subscribes each game once it opens, and a later game at once', function () {
      const { socket } = makeSocket()
      socket.subscribe('g1', () => undefined)
      socket.subscribe('g1', () => undefined)
      expect(last().sent).deep.equals([])
      last().open()
      expect(socket.connected).equals(true)
      socket.subscribe('g2', () => undefined)
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          gameId: 'g1',
          id: 'c1',
          protocol: GAME_SOCKET_PROTOCOL
        },
        {
          type: 'subscribe',
          gameId: 'g2',
          id: 'c2',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      socket.close()
    })
  })

  describe('reconnecting', function () {
    it('waits 1, 2, 4, 8 and then 15 seconds, and starts again after a success', function () {
      const { socket, timers } = makeSocket()
      socket.subscribe('g1', () => undefined)
      for (let i = 0; i < 6; i++) {
        last().drop()
        timers.fire()
      }
      expect(timers.delays).deep.equals([...RECONNECT_DELAYS_MS, 15000])
      expect(RECONNECT_DELAYS_MS).deep.equals([1000, 2000, 4000, 8000, 15000])
      last().open()
      last().drop()
      expect(timers.delays[timers.delays.length - 1]).equals(1000)
      socket.close()
      expect(timers.pending()).equals(0)
    })

    it('treats an error as a drop', function () {
      const { socket, timers } = makeSocket()
      socket.subscribe('g1', () => undefined)
      const failed = last()
      failed.onerror?.({})
      expect(failed.closedWith).equals(1005)
      // The close that follows the error is the same drop, not a second one.
      failed.drop()
      expect(timers.delays).deep.equals([1000])
      socket.close()
    })

    it('resubscribes every game and tells every listener to resync', function () {
      const { socket, timers } = makeSocket()
      const heard: GameSocketEvent[] = []
      const statuses: boolean[] = []
      const stopStatus = socket.onStatus(connected => statuses.push(connected))
      socket.subscribe('g1', event => heard.push(event))
      socket.subscribe('g2', event => heard.push(event))
      last().open()
      expect(heard).deep.equals([])
      last().drop()
      expect(socket.connected).equals(false)
      timers.fire()
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          gameId: 'g1',
          id: 'c3',
          protocol: GAME_SOCKET_PROTOCOL
        },
        {
          type: 'subscribe',
          gameId: 'g2',
          id: 'c4',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      expect(heard).deep.equals([
        { type: 'resync', gameId: 'g1' },
        { type: 'resync', gameId: 'g2' }
      ])
      expect(statuses).deep.equals([true, false, true])
      stopStatus()
      socket.close()
      expect(statuses).deep.equals([true, false, true])
    })

    it('resyncs when the first connection only succeeds on a retry', function () {
      const { socket, timers } = makeSocket()
      const heard: GameSocketEvent[] = []
      socket.subscribe('g1', event => heard.push(event))
      last().drop()
      timers.fire()
      last().open()
      expect(heard).deep.equals([{ type: 'resync', gameId: 'g1' }])
      socket.close()
    })
  })

  describe('listening', function () {
    it('hands each game its own changes', function () {
      const { socket } = makeSocket()
      const one: GameSocketEvent[] = []
      const two: GameSocketEvent[] = []
      socket.subscribe('g1', event => one.push(event))
      socket.subscribe('g2', event => two.push(event))
      last().open()
      const change = {
        type: 'change',
        gameId: 'g1',
        kind: 'game',
        at: '2026-09-28T00:00:00.000Z',
        data: { status: 'inProgress', awayScore: 1, homeScore: 0 }
      }
      last().receive(change)
      last().receive({ type: 'subscribed', gameId: 'g1', id: 'c1' })
      last().receive({ type: 'pong', id: 'c9' })
      // Nothing that does not read reaches anybody.
      last().receive('not json')
      last().receive(new Uint8Array([1]))
      last().onmessage?.({ data: 7 })
      last().receive({ type: 'change', gameId: 'g1', kind: 'weather' })
      last().receive({ kind: 'playEdits' })
      last().receive({ type: 'change', gameId: 'g1', kind: 'plays' })
      last().receive({ type: 'error', code: 'unknown', message: 'x' })
      last().receive({ ...change, gameId: 'g9' })
      expect(one).deep.equals([change, { type: 'subscribed', gameId: 'g1' }])
      expect(two).deep.equals([])
      socket.close()
    })

    it('passes on an older worker’s whole list of plays as the re-read form, with its digest', function () {
      const { socket } = makeSocket()
      const heard: GameSocketEvent[] = []
      socket.subscribe('g1', event => heard.push(event))
      last().open()
      const reread = (digest: string | null): GameSocketEvent => ({
        type: 'change',
        gameId: 'g1',
        kind: 'playEdits',
        at: '2026-09-28T00:00:00.000Z',
        data: {
          generation: -1,
          fromDigest: null,
          digest,
          namesDigest: null,
          edits: null
        }
      })
      const legacy = {
        type: 'change',
        gameId: 'g1',
        kind: 'plays',
        at: '2026-09-28T00:00:00.000Z',
        data: { plays: [{}], currentPlay: null, digest: 'd0' }
      }
      last().receive(legacy)
      // Without a digest, or with data that does not read, it still says
      // to read again.
      last().receive({ ...legacy, data: { plays: [] } })
      last().receive({ ...legacy, data: 'garbled' })
      last().receive({ ...legacy, data: { digest: 7 } })
      // A frame that is not a change, or names no game, is still dropped.
      last().receive({ ...legacy, gameId: 3 })
      last().receive({ ...legacy, at: undefined })
      expect(heard).deep.equals([
        reread('d0'),
        reread(null),
        reread(null),
        reread(null)
      ])
      socket.close()
    })

    it('keeps a game\u2019s other listener hearing when one goes, as DJ Game does when a replay of the same game closes', function () {
      const { socket } = makeSocket()
      const dj: GameSocketEvent[] = []
      const replay: GameSocketEvent[] = []
      socket.subscribe('g1', event => dj.push(event))
      const closeReplay = socket.subscribe('g1', event => replay.push(event))
      last().open()
      expect(last().sent).lengthOf(1)
      const plays = {
        type: 'change',
        gameId: 'g1',
        kind: 'playEdits',
        at: 'x',
        data: { generation: 0, fromDigest: null, digest: null, edits: null }
      }
      last().receive(plays)
      expect(dj).deep.equals([plays])
      expect(replay).deep.equals([plays])
      closeReplay()
      last().receive({ ...plays, at: 'y' })
      expect(dj).deep.equals([plays, { ...plays, at: 'y' }])
      expect(replay).deep.equals([plays])
      expect(last().sent).lengthOf(1)
      socket.close()
    })

    it('sends unsubscribe when the last listener of a game goes', function () {
      const { socket } = makeSocket()
      const heard: GameSocketEvent[] = []
      const first = socket.subscribe('g1', event => heard.push(event))
      const second = socket.subscribe('g1', () => undefined)
      last().open()
      first()
      first()
      expect(last().sent).lengthOf(1)
      second()
      expect(last().sent[1]).deep.equals({
        type: 'unsubscribe',
        gameId: 'g1',
        id: 'c2'
      })
      last().receive({
        type: 'change',
        gameId: 'g1',
        kind: 'playEdits',
        at: 'x',
        data: {}
      })
      expect(heard).deep.equals([])
      socket.close()
      second()
    })

    it('gives an error to the game it was about, or to every game', function () {
      const { socket } = makeSocket()
      const one: GameSocketEvent[] = []
      const two: GameSocketEvent[] = []
      socket.subscribe('g1', event => one.push(event))
      socket.subscribe('g2', event => two.push(event))
      last().open()
      // By the subscribe's id, as the server answers an unseen game.
      last().receive({
        type: 'error',
        id: 'c2',
        code: 'notFound',
        message: 'No such game'
      })
      last().receive({
        type: 'error',
        gameId: 'g1',
        code: 'tooMany',
        message: 'Too many'
      })
      last().receive({ type: 'error', code: 'malformed', message: 'Bad' })
      expect(one).deep.equals([
        { type: 'error', gameId: 'g1', code: 'tooMany', message: 'Too many' },
        { type: 'error', gameId: 'g1', code: 'malformed', message: 'Bad' }
      ])
      expect(two).deep.equals([
        {
          type: 'error',
          gameId: 'g2',
          code: 'notFound',
          message: 'No such game'
        },
        { type: 'error', gameId: 'g2', code: 'malformed', message: 'Bad' }
      ])
      socket.close()
    })

    it('gives the server failing (internal) to the game, and keeps going', function () {
      const { socket } = makeSocket()
      const heard: GameSocketEvent[] = []
      socket.subscribe('g1', event => heard.push(event))
      last().open()
      last().receive({
        type: 'error',
        id: 'c1',
        gameId: 'g1',
        code: 'internal',
        message: 'The server could not subscribe; try again'
      })
      last().receive({
        type: 'change',
        gameId: 'g1',
        kind: 'game',
        at: 'x',
        data: {}
      })
      expect(heard.map(event => event.type)).deep.equals(['error', 'change'])
      expect(heard[0]).deep.include({ gameId: 'g1', code: 'internal' })
      expect(socket.connected).equals(true)
      socket.close()
    })
  })

  describe('asking again after internal', function () {
    const internal = (id: string): unknown => ({
      type: 'error',
      id,
      gameId: 'g1',
      code: 'internal',
      message: 'The server could not subscribe; try again'
    })
    const subscribes = (): unknown[] =>
      last().sent.filter(
        frame => (frame as { type: string }).type === 'subscribe'
      )

    it('waits 1, 2, 4, 8 and then 15 seconds, and starts again after a success', function () {
      const { socket, timers } = makeSocket()
      const heard: GameSocketEvent[] = []
      socket.subscribe('g1', event => heard.push(event))
      last().open()
      for (let i = 1; i <= 6; i++) {
        last().receive(internal(`c${i}`))
        expect(timers.pending()).equals(1)
        timers.fire()
      }
      expect(timers.delays).deep.equals([...RESUBSCRIBE_DELAYS_MS, 15000])
      expect(RESUBSCRIBE_DELAYS_MS).deep.equals([1000, 2000, 4000, 8000, 15000])
      expect(subscribes()).deep.equals(
        [1, 2, 3, 4, 5, 6, 7].map(i => ({
          type: 'subscribe',
          gameId: 'g1',
          id: `c${i}`,
          protocol: GAME_SOCKET_PROTOCOL
        }))
      )
      last().receive({ type: 'subscribed', gameId: 'g1', id: 'c7' })
      expect(heard[heard.length - 1]).deep.equals({
        type: 'subscribed',
        gameId: 'g1'
      })
      expect(heard.filter(event => event.type === 'error').length).equals(6)
      expect(timers.pending()).equals(0)
      // A late refusal of a subscribe already answered asks nothing.
      last().receive(internal('c7'))
      expect(timers.pending()).equals(0)
      // Another game's failure starts from one second.
      socket.subscribe('g2', () => undefined)
      last().receive({ ...(internal('c8') as object), gameId: 'g2' })
      expect(timers.delays.slice(-1)).deep.equals([1000])
      socket.close()
      expect(timers.pending()).equals(0)
    })

    it('stops asking once the game is no longer wanted', function () {
      const { socket, timers } = makeSocket()
      const stop = socket.subscribe('g1', () => undefined)
      last().open()
      last().receive(internal('c1'))
      expect(timers.pending()).equals(1)
      stop()
      expect(timers.pending()).equals(0)
      expect(subscribes().length).equals(1)
      // Refused after it was dropped: nothing to ask again for.
      const again = socket.subscribe('g1', () => undefined)
      again()
      last().receive(internal('c3'))
      expect(timers.pending()).equals(0)
      socket.close()
    })

    it('leaves it to the reconnect when the socket drops, and to close', function () {
      const { socket, timers } = makeSocket()
      socket.subscribe('g1', () => undefined)
      last().open()
      last().receive(internal('c1'))
      last().drop()
      // Only the reconnect waits now.
      expect(timers.pending()).equals(1)
      timers.fire()
      last().open()
      expect(subscribes()).deep.equals([
        {
          type: 'subscribe',
          gameId: 'g1',
          id: 'c2',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      last().receive(internal('c2'))
      expect(timers.pending()).equals(1)
      socket.close()
      expect(timers.pending()).equals(0)
    })

    it('asks once, when another subscribe for the game is already out', function () {
      const { socket, timers } = makeSocket()
      // Chat keeps the socket open while g1 has no listener.
      socket.onChat(() => undefined)
      const first = socket.subscribe('g1', () => undefined)
      last().open()
      first()
      socket.subscribe('g1', () => undefined)
      // c1 was the first subscribe, c3 the second, still unanswered.
      last().receive(internal('c1'))
      expect(timers.pending()).equals(0)
      last().receive(internal('c3'))
      expect(timers.pending()).equals(1)
      // A second refusal while waiting does not stack a second timer.
      last().receive(internal('c3'))
      expect(timers.pending()).equals(1)
      // An internal that answers no subscribe is only passed on.
      last().receive({ type: 'error', code: 'internal', message: 'x' })
      expect(timers.pending()).equals(1)
      socket.close()
    })
  })

  describe('an app older than the server reads', function () {
    const updateRequired = (id: string): Record<string, unknown> => ({
      type: 'error',
      id,
      code: 'forbidden',
      reason: 'updateRequired',
      message: 'Update TeamStation to keep following games.'
    })

    it('tells the game and onUpdateRequired once, and never asks for that game again', function () {
      const { socket, timers } = makeSocket()
      const heard: GameSocketEvent[] = []
      const other: GameSocketEvent[] = []
      let told = 0
      const stopHearing = socket.onUpdateRequired(() => {
        told++
      })
      socket.subscribe('g1', event => heard.push(event))
      socket.subscribe('g2', event => other.push(event))
      last().open()
      last().receive(updateRequired('c1'))
      // A second refusal of the same game, as a late duplicate, says nothing.
      last().receive(updateRequired('c1'))
      expect(heard).deep.equals([{ type: 'updateRequired', gameId: 'g1' }])
      expect(other).deep.equals([])
      expect(told).equals(1)
      expect(timers.pending()).equals(0)
      // A reconnect asks again only for the game that was not refused.
      last().drop()
      timers.fire()
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          gameId: 'g2',
          id: 'c3',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      expect(heard.filter(event => event.type === 'updateRequired')).lengthOf(1)
      stopHearing()
      socket.close()
    })

    it('sends no unsubscribe for a refused game, and asks again for it once it is wanted anew', function () {
      const { socket } = makeSocket()
      const heard: GameSocketEvent[] = []
      const stop = socket.subscribe('g1', event => heard.push(event))
      const chat = socket.onChat(() => undefined)
      last().open()
      last().receive(updateRequired('c1'))
      stop()
      stop()
      expect(last().sent).lengthOf(1)
      socket.subscribe('g1', event => heard.push(event))
      expect(last().sent[1]).deep.equals({
        type: 'subscribe',
        gameId: 'g1',
        id: 'c2',
        protocol: GAME_SOCKET_PROTOCOL
      })
      last().receive(updateRequired('c2'))
      expect(heard).deep.equals([
        { type: 'updateRequired', gameId: 'g1' },
        { type: 'updateRequired', gameId: 'g1' }
      ])
      chat()
      socket.close()
    })

    it('closes the socket when the refused game was all it held', function () {
      const { socket } = makeSocket()
      const stop = socket.subscribe('g1', () => undefined)
      const socketOf = last()
      socketOf.open()
      socketOf.receive(updateRequired('c1'))
      stop()
      expect(socketOf.closedWith).equals(1000)
      expect(socketOf.sent).lengthOf(1)
    })

    it('passes on a forbidden refusal with no reason, or one it does not know, as any other error', function () {
      const { socket } = makeSocket()
      const heard: GameSocketEvent[] = []
      let told = 0
      socket.onUpdateRequired(() => {
        told++
      })
      socket.subscribe('g1', event => heard.push(event))
      last().open()
      last().receive({
        type: 'error',
        id: 'c1',
        code: 'forbidden',
        message: 'No'
      })
      socket.subscribe('g2', () => undefined)
      last().receive({
        type: 'error',
        id: 'c2',
        code: 'forbidden',
        reason: 'somethingNewer',
        message: 'Not yet'
      })
      expect(heard).deep.equals([
        { type: 'error', gameId: 'g1', code: 'forbidden', message: 'No' }
      ])
      expect(told).equals(0)
      socket.close()
    })

    it('ignores a refusal of a subscribe it did not send', function () {
      const { socket } = makeSocket()
      const heard: GameSocketEvent[] = []
      let told = 0
      socket.onUpdateRequired(() => {
        told++
      })
      socket.subscribe('g1', event => heard.push(event))
      last().open()
      last().receive(updateRequired('nobody'))
      last().receive({
        type: 'error',
        code: 'forbidden',
        reason: 'updateRequired',
        message: 'Update TeamStation to keep following games.'
      })
      expect(heard).deep.equals([])
      expect(told).equals(0)
      socket.close()
    })
  })

  describe('closing', function () {
    it('closes the socket, stops reconnecting, and refuses new subscriptions', function () {
      const { socket, timers } = makeSocket()
      socket.subscribe('g1', () => undefined)
      const open = last()
      open.open()
      socket.close()
      socket.close()
      expect(open.closedWith).equals(1000)
      expect(open.onclose).equals(null)
      expect(() => socket.subscribe('g2', () => undefined)).throws(/closed/)
      expect(timers.pending()).equals(0)

      // Closed while waiting to reconnect.
      const waiting = makeSocket()
      waiting.socket.subscribe('g1', () => undefined)
      last().drop()
      expect(waiting.timers.pending()).equals(1)
      waiting.socket.close()
      expect(waiting.timers.pending()).equals(0)
    })
  })

  describe('screen scopes', function () {
    it('connects on the first scope, and subscribes it once open', function () {
      const { socket } = makeSocket({ token: 'tok_phone' })
      const heard: ScreenScopeEvent[] = []
      socket.subscribeScope({ scope: 'home' }, event => heard.push(event))
      expect(FakeSocket.made).lengthOf(1)
      expect(last().options).deep.equals({
        headers: { Authorization: 'Bearer tok_phone' }
      })
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          scope: 'home',
          id: 'c1',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      last().receive({
        type: 'subscribed',
        scope: 'home',
        id: 'c1'
      })
      expect(heard).deep.equals([{ type: 'subscribed' }])
      socket.close()
    })

    it('names the game of an event scope, and hears only that game', function () {
      const { socket } = makeSocket()
      const heard: ScreenScopeEvent[] = []
      last()
      socket.subscribeScope({ scope: 'event', gameId: 'g1' }, event =>
        heard.push(event)
      )
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          scope: 'event',
          gameId: 'g1',
          id: 'c1',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      last().receive({
        type: 'changed',
        scope: 'event',
        gameId: 'g2'
      })
      last().receive({ type: 'changed', scope: 'home' })
      last().receive({ type: 'changed', scope: 'event' })
      last().receive({ type: 'changed', scope: 'nowhere' })
      last().receive({
        type: 'changed',
        scope: 'event',
        gameId: 'g1'
      })
      // A post's own notice says so, for the game's screen to let it pass.
      last().receive({
        type: 'changed',
        scope: 'event',
        gameId: 'g1',
        byPost: true
      })
      last().receive({
        type: 'changed',
        scope: 'event',
        gameId: 'g1',
        byPost: false
      })
      expect(heard).deep.equals([
        { type: 'changed', gameId: 'g1' },
        { type: 'changed', gameId: 'g1', byPost: true },
        { type: 'changed', gameId: 'g1' }
      ])
      socket.close()
    })

    it('keeps its answers away from game listeners, and game frames away from it (Scope frame, Game frames)', function () {
      const { socket } = makeSocket()
      const scope: ScreenScopeEvent[] = []
      const game: GameSocketEvent[] = []
      socket.subscribe('g1', event => game.push(event))
      socket.subscribeScope({ scope: 'event', gameId: 'g1' }, event =>
        scope.push(event)
      )
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          gameId: 'g1',
          id: 'c1',
          protocol: GAME_SOCKET_PROTOCOL
        },
        {
          type: 'subscribe',
          scope: 'event',
          gameId: 'g1',
          id: 'c2',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      // The event scope refused: its error has no game, and still reaches
      // only the scope.
      last().receive({
        type: 'error',
        id: 'c2',
        code: 'notFound',
        message: 'No such game'
      })
      const change = {
        type: 'change',
        gameId: 'g1',
        kind: 'playEdits',
        at: '2026-10-21T00:00:00.000Z',
        data: {
          generation: 0,
          fromDigest: 'd0',
          digest: 'd1',
          edits: [],
          currentPlay: null
        }
      }
      last().receive(change)
      last().receive({ type: 'subscribed', gameId: 'g1', id: 'c1' })
      expect(scope).deep.equals([
        { type: 'error', code: 'notFound', message: 'No such game' }
      ])
      expect(game).deep.equals([change, { type: 'subscribed', gameId: 'g1' }])
      // An answer that does not read is nobody's.
      socket.subscribeScope({ scope: 'home' }, event => scope.push(event))
      last().receive({ type: 'error', id: 'c3' })
      last().receive({ type: 'unsubscribed', scope: 'home', id: 'c3' })
      expect(scope).lengthOf(1)
      expect(game).lengthOf(2)
      socket.close()
    })

    it('replaces the scope it holds, and drops the old one’s answers (Replaced scope)', function () {
      const { socket } = makeSocket()
      const home: ScreenScopeEvent[] = []
      const schedule: ScreenScopeEvent[] = []
      const leaveHome = socket.subscribeScope({ scope: 'home' }, event =>
        home.push(event)
      )
      last().open()
      const leaveSchedule = socket.subscribeScope(
        { scope: 'schedule' },
        event => schedule.push(event)
      )
      last().receive({
        type: 'subscribed',
        scope: 'home',
        id: 'c1'
      })
      last().receive({ type: 'changed', scope: 'home' })
      leaveHome()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          scope: 'home',
          id: 'c1',
          protocol: GAME_SOCKET_PROTOCOL
        },
        {
          type: 'subscribe',
          scope: 'schedule',
          id: 'c2',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      expect(home).deep.equals([])
      expect(schedule).deep.equals([])
      last().receive({
        type: 'subscribed',
        scope: 'schedule',
        id: 'c2'
      })
      expect(schedule).deep.equals([{ type: 'subscribed' }])
      leaveSchedule()
      leaveSchedule()
      expect(last().sent.slice(2)).deep.equals([
        { type: 'unsubscribe', scope: 'schedule', id: 'c3' }
      ])
      last().receive({ type: 'unsubscribed', scope: 'schedule', id: 'c3' })
      last().receive({ type: 'changed', scope: 'schedule' })
      expect(schedule).lengthOf(1)
      // Let go before it opened, nothing is sent.
      const quiet = makeSocket()
      quiet.socket.subscribeScope({ scope: 'home' }, () => undefined)()
      last().open()
      expect(last().sent).deep.equals([])
      quiet.socket.close()
      socket.close()
    })

    it('asks again and waits for a new ack after a server resync or a reconnect (Reconnect)', function () {
      const { socket, timers } = makeSocket()
      const heard: ScreenScopeEvent[] = []
      socket.subscribeScope({ scope: 'schedule' }, event => heard.push(event))
      last().open()
      last().receive({
        type: 'subscribed',
        scope: 'schedule',
        id: 'c1'
      })
      last().receive({ type: 'resync' })
      expect(last().sent[1]).deep.equals({
        type: 'subscribe',
        scope: 'schedule',
        id: 'c2',
        protocol: GAME_SOCKET_PROTOCOL
      })
      // The old subscribe's answer no longer counts.
      last().receive({
        type: 'subscribed',
        scope: 'schedule',
        id: 'c1'
      })
      last().receive({
        type: 'subscribed',
        scope: 'schedule',
        id: 'c2'
      })
      expect(heard).deep.equals([
        { type: 'subscribed' },
        { type: 'resync' },
        { type: 'subscribed' }
      ])
      // A dropped socket voids the ack, says it is down, and the reconnect
      // asks again.
      last().drop(1006)
      expect(heard.slice(-2)).deep.equals([
        { type: 'resync' },
        { type: 'unreachable' }
      ])
      expect(timers.delays).deep.equals([1000])
      timers.fire()
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          scope: 'schedule',
          id: 'c3',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      last().receive({
        type: 'subscribed',
        scope: 'schedule',
        id: 'c3'
      })
      expect(heard.at(-1)).deep.equals({ type: 'subscribed' })
      expect(heard).lengthOf(6)
      // A resync with nothing held, or after the scope stopped, asks nothing.
      const idle = makeSocket()
      idle.socket.subscribe('g1', () => undefined)
      last().open()
      last().receive({ type: 'resync' })
      expect(last().sent).lengthOf(1)
      idle.socket.close()
      socket.close()
    })

    it('retries a close before open on the existing delays, even with 1008 (Reconnect)', function () {
      const { socket, timers } = makeSocket()
      const heard: ScreenScopeEvent[] = []
      socket.subscribeScope({ scope: 'home' }, event => heard.push(event))
      last().drop(1008)
      timers.fire()
      last().drop()
      timers.fire()
      expect(timers.delays).deep.equals([1000, 2000])
      // Each failed connect says the socket is down: the screen reads at once.
      expect(heard).deep.equals([
        { type: 'unreachable' },
        { type: 'unreachable' }
      ])
      // A screen arriving while it waits to retry hears so at once too, and
      // one on a first connect on its way does not.
      const later: ScreenScopeEvent[] = []
      socket.subscribeScope({ scope: 'schedule' }, event => later.push(event))
      expect(later).deep.equals([{ type: 'unreachable' }])
      const retrying = last()
      const first = makeSocket()
      const fresh: ScreenScopeEvent[] = []
      first.socket.subscribeScope({ scope: 'home' }, event => fresh.push(event))
      expect(fresh).deep.equals([])
      first.socket.close()
      retrying.open()
      expect(retrying.sent).deep.equals([
        {
          type: 'subscribe',
          scope: 'schedule',
          id: 'c1',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      socket.close()
    })

    it('stops after a 1008 once open, until the token changes (Reconnect)', function () {
      const { socket, timers } = makeSocket({ token: 'tok_old' })
      const heard: ScreenScopeEvent[] = []
      socket.subscribeScope({ scope: 'home' }, event => heard.push(event))
      last().open()
      last().drop(1008)
      expect(heard).deep.equals([{ type: 'stopped' }])
      expect(timers.pending()).equals(0)
      // A new screen while stopped hears so at once, and nothing connects.
      socket.subscribeScope({ scope: 'schedule' }, event => heard.push(event))
      expect(heard.at(-1)).deep.equals({ type: 'stopped' })
      expect(FakeSocket.made).lengthOf(1)
      socket.setToken('tok_old')
      expect(FakeSocket.made).lengthOf(1)
      socket.setToken('tok_new')
      expect(FakeSocket.made).lengthOf(2)
      expect(last().options).deep.equals({
        headers: { Authorization: 'Bearer tok_new' }
      })
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          scope: 'schedule',
          id: 'c2',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      socket.close()
    })

    it('keeps game subscriptions retrying after a 1008, without the scope', function () {
      const { socket, timers } = makeSocket()
      const heard: ScreenScopeEvent[] = []
      socket.subscribe('g1', () => undefined)
      socket.subscribeScope({ scope: 'home' }, event => heard.push(event))
      last().open()
      last().drop(1008)
      expect(heard).deep.equals([{ type: 'stopped' }])
      expect(timers.delays).deep.equals([1000])
      timers.fire()
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          gameId: 'g1',
          id: 'c3',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      // The new token reconnects at once and asks for both.
      socket.setToken('tok_new')
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          gameId: 'g1',
          id: 'c4',
          protocol: GAME_SOCKET_PROTOCOL
        },
        {
          type: 'subscribe',
          scope: 'home',
          id: 'c5',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      socket.close()
    })

    it('stops on a 401 from REST, and closes a socket that only held the scope (Reconnect)', function () {
      const { socket, timers } = makeSocket()
      const heard: ScreenScopeEvent[] = []
      socket.subscribeScope({ scope: 'home' }, event => heard.push(event))
      const first = last()
      first.open()
      first.receive({
        type: 'subscribed',
        scope: 'home',
        id: 'c1'
      })
      socket.authFailed()
      socket.authFailed()
      expect(first.sent.at(-1)).deep.equals({
        type: 'unsubscribe',
        scope: 'home',
        id: 'c2'
      })
      expect(first.closedWith).equals(1000)
      expect(socket.connected).equals(false)
      expect(timers.pending()).equals(0)
      expect(heard).deep.equals([{ type: 'subscribed' }, { type: 'stopped' }])
      // While waiting to reconnect, a 401 cancels the wait.
      const waiting = makeSocket()
      waiting.socket.subscribeScope({ scope: 'home' }, () => undefined)
      last().drop()
      expect(waiting.timers.pending()).equals(1)
      waiting.socket.authFailed()
      expect(waiting.timers.pending()).equals(0)
      // A token given before anything connects waits for a subscribe.
      waiting.socket.close()
      const fresh = makeSocket()
      fresh.socket.setToken('tok_later')
      expect(FakeSocket.made).lengthOf(0)
      fresh.socket.subscribeScope({ scope: 'home' }, () => undefined)
      expect(last().options).deep.equals({
        headers: { Authorization: 'Bearer tok_later' }
      })
      fresh.socket.close()
      fresh.socket.authFailed()
      fresh.socket.setToken('tok_after')
      expect(() =>
        fresh.socket.subscribeScope({ scope: 'home' }, () => undefined)
      ).throws(/closed/)
      socket.close()
    })

    it('tells onUpdateRequired of a scope refused as too old, and asks for no scope again', function () {
      const { socket, timers } = makeSocket()
      let told = 0
      socket.onUpdateRequired(() => {
        told++
      })
      const heard: ScreenScopeEvent[] = []
      socket.subscribe('g1', () => undefined)
      socket.subscribeScope({ scope: 'home' }, event => heard.push(event))
      last().open()
      expect(last().sent[1]).deep.equals({
        type: 'subscribe',
        scope: 'home',
        id: 'c2',
        protocol: GAME_SOCKET_PROTOCOL
      })
      last().receive({
        type: 'error',
        id: 'c2',
        code: 'forbidden',
        reason: 'updateRequired',
        message: 'Update TeamStation to keep following games.'
      })
      expect(told).equals(1)
      expect(heard).deep.equals([
        {
          type: 'error',
          code: 'forbidden',
          message: 'Update TeamStation to keep following games.'
        }
      ])
      // A screen after it hears so at once, and nothing is sent for it.
      socket.subscribeScope({ scope: 'schedule' }, event => heard.push(event))
      expect(heard.at(-1)).deep.equals({
        type: 'error',
        code: 'forbidden',
        message: 'Update TeamStation to keep following this screen.'
      })
      expect(last().sent).lengthOf(2)
      // A reconnect asks for the game again, and for no scope.
      last().drop(1006)
      expect(heard).lengthOf(2)
      timers.fire()
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          gameId: 'g1',
          id: 'c3',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      expect(told).equals(1)
      socket.close()

      // A socket that held only the refused scope closes.
      const lone = makeSocket()
      lone.socket.subscribeScope({ scope: 'home' }, () => undefined)
      const only = last()
      only.open()
      only.receive({
        type: 'error',
        id: 'c1',
        code: 'forbidden',
        reason: 'updateRequired',
        message: 'Update TeamStation to keep following games.'
      })
      expect(only.closedWith).equals(1000)
      expect(lone.socket.connected).equals(false)
      lone.socket.close()
    })

    it('passes on the one game a home notice names, and whether a post made it', function () {
      const { socket } = makeSocket()
      const heard: ScreenScopeEvent[] = []
      socket.subscribeScope({ scope: 'home' }, event => heard.push(event))
      last().open()
      last().receive({
        type: 'changed',
        scope: 'home',
        gameId: 'g1'
      })
      last().receive({ type: 'changed', scope: 'home' })
      last().receive({
        type: 'changed',
        scope: 'home',
        gameId: 'g1',
        byPost: true
      })
      expect(heard).deep.equals([
        { type: 'changed', gameId: 'g1' },
        { type: 'changed' },
        { type: 'changed', gameId: 'g1', byPost: true }
      ])
      socket.close()
    })

    it('keeps a socket with games open on a 401, and lets the scope go on close', function () {
      const { socket } = makeSocket()
      const heard: ScreenScopeEvent[] = []
      socket.subscribe('g1', () => undefined)
      socket.subscribeScope({ scope: 'home' }, event => heard.push(event))
      socket.authFailed()
      expect(heard).deep.equals([{ type: 'stopped' }])
      last().open()
      expect(last().sent).deep.equals([
        {
          type: 'subscribe',
          gameId: 'g1',
          id: 'c1',
          protocol: GAME_SOCKET_PROTOCOL
        }
      ])
      expect(socket.connected).equals(true)
      socket.close()
      last().receive({ type: 'changed', scope: 'home' })
      expect(heard).lengthOf(1)
    })
  })
})

/** U9: chat on the same socket, against a fake WebSocket. */
describe('GameSocket chat (U9)', function () {
  const hint = {
    type: 'chat',
    conversationId: 'cnv_1',
    kind: 'message',
    seq: 4,
    at: '2027-04-10T12:00:00.000Z'
  }

  it('opens the socket with no game subscribed, and closes it when the last listener of either kind goes', function () {
    const { socket } = makeSocket({ token: 'tok_phone' })
    expect(FakeSocket.made).lengthOf(0)
    const statuses: boolean[] = []
    socket.onStatus(connected => statuses.push(connected))
    const stopChat = socket.onChat(() => undefined)
    expect(FakeSocket.made).lengthOf(1)
    expect(last().options).deep.equals({
      headers: { Authorization: 'Bearer tok_phone' }
    })
    last().open()
    expect(socket.connected).equals(true)
    // A game too, then the chat listener goes: still open for the game.
    const stopGame = socket.subscribe('g1', () => undefined)
    const second = socket.onChat(() => undefined)
    stopChat()
    stopChat()
    second()
    expect(last().closedWith).equals(undefined)
    expect(socket.connected).equals(true)
    // The game goes last: it is unsubscribed, then the socket closes.
    stopGame()
    expect(last().sent.slice(-1)).deep.equals([
      { type: 'unsubscribe', gameId: 'g1', id: 'c2' }
    ])
    expect(last().closedWith).equals(1000)
    expect(last().onmessage).equals(null)
    expect(socket.connected).equals(false)
    expect(statuses).deep.equals([true, false])
    // A new listener opens a new socket, with nothing to resync.
    const heard: ChatSocketEvent[] = []
    const again = socket.onChat(event => heard.push(event))
    expect(FakeSocket.made).lengthOf(2)
    last().open()
    expect(heard).deep.equals([])
    again()
    socket.close()
  })

  it('stops waiting to reconnect when the last listener goes', function () {
    const { socket, timers } = makeSocket()
    const stop = socket.onChat(() => undefined)
    last().drop()
    expect(timers.pending()).equals(1)
    stop()
    expect(timers.pending()).equals(0)
    // Nobody missed anything, so the next connection does not resync.
    const heard: ChatSocketEvent[] = []
    socket.onChat(event => heard.push(event))
    expect(FakeSocket.made).lengthOf(2)
    last().open()
    expect(heard).deep.equals([])
    socket.close()
  })

  it('hands chat frames to chat listeners only, and game frames to games only', function () {
    const { socket } = makeSocket()
    const chat: ChatSocketEvent[] = []
    const game: GameSocketEvent[] = []
    socket.onChat(event => chat.push(event))
    socket.subscribe('g1', event => game.push(event))
    last().open()
    const { seq: _seq, ...noSeq } = hint
    const frames = [
      hint,
      { ...noSeq, kind: 'members' },
      { type: 'chatUser', kind: 'devices' },
      {
        type: 'chatTyping',
        conversationId: 'cnv_1',
        userId: userIdOfValue((1n << 127n) + 7n)
      },
      { type: 'resync' }
    ]
    for (const frame of frames) last().receive(frame)
    // Frames that do not read reach nobody.
    last().receive({ ...hint, kind: 'weather' })
    last().receive({ ...hint, seq: 'four' })
    last().receive({ type: 'chatUser', kind: 'everything' })
    last().receive({ type: 'chatTyping', conversationId: 'cnv_1' })
    last().receive({ type: 'chatTyping', conversationId: 'cnv_1', userId: 7 })
    last().receive({ type: 'chatTyping', conversationId: 'cnv_1', userId: '7' })
    last().receive({ type: 'typed', conversationId: 'cnv_1', id: 'c9' })
    last().receive({ type: 'typed', conversationId: 'cnv_1' })
    expect(chat).deep.equals(frames)
    expect(Object.keys(chat[1])).not.include('seq')
    expect(game).deep.equals([])
    const change = {
      type: 'change',
      gameId: 'g1',
      kind: 'game',
      at: 'x',
      data: {}
    }
    last().receive(change)
    expect(game).deep.equals([change])
    expect(chat).lengthOf(frames.length)
    socket.close()
  })

  it('tells chat listeners to resync after a reconnect, and not on the first connection', function () {
    const { socket, timers } = makeSocket()
    const heard: ChatSocketEvent[] = []
    const games: GameSocketEvent[] = []
    socket.onChat(event => heard.push(event))
    socket.subscribe('g1', event => games.push(event))
    last().open()
    expect(heard).deep.equals([])
    last().drop()
    timers.fire()
    last().open()
    expect(heard).deep.equals([{ type: 'resync' }])
    expect(games).deep.equals([{ type: 'resync', gameId: 'g1' }])
    socket.close()
  })

  it('sends typing only while open, at most once every three seconds', function () {
    let now = 50_000
    const { socket } = makeSocket({ now: () => now })
    const heard: ChatSocketEvent[] = []
    socket.onChat(event => heard.push(event))
    expect(socket.sendTyping('cnv_1')).equals(false)
    last().open()
    expect(TYPING_INTERVAL_MS).equals(3000)
    expect(socket.sendTyping('cnv_1')).equals(true)
    now += TYPING_INTERVAL_MS - 1
    expect(socket.sendTyping('cnv_2')).equals(false)
    now += 1
    expect(socket.sendTyping('cnv_2')).equals(true)
    expect(last().sent).deep.equals([
      { type: 'typing', conversationId: 'cnv_1', id: 'c1' },
      { type: 'typing', conversationId: 'cnv_2', id: 'c2' }
    ])
    last().receive({ type: 'typed', conversationId: 'cnv_1', id: 'c1' })
    expect(heard).deep.equals([])
    socket.close()
    expect(socket.sendTyping('cnv_1')).equals(false)
    expect(() => socket.onChat(() => undefined)).throws(/closed/)
  })

  it('gives a refused typing hint to chat listeners, never to every game', function () {
    let now = 0
    const { socket } = makeSocket({ now: () => now })
    const chat: ChatSocketEvent[] = []
    const game: GameSocketEvent[] = []
    socket.onChat(event => chat.push(event))
    socket.subscribe('g1', event => game.push(event))
    last().open()
    socket.sendTyping('cnv_1')
    // By its id alone.
    last().receive({
      type: 'error',
      id: 'c2',
      code: 'forbidden',
      message: 'Only those who may post here may type'
    })
    // By the conversation it names.
    last().receive({
      type: 'error',
      conversationId: 'cnv_2',
      code: 'notFound',
      message: 'No such conversation'
    })
    // The id has been answered: a repeat is anybody's error, as before.
    last().receive({ type: 'error', id: 'c2', code: 'tooMany', message: 'x' })
    expect(chat).deep.equals([
      {
        type: 'error',
        conversationId: 'cnv_1',
        code: 'forbidden',
        message: 'Only those who may post here may type'
      },
      {
        type: 'error',
        conversationId: 'cnv_2',
        code: 'notFound',
        message: 'No such conversation'
      }
    ])
    expect(game).deep.equals([
      { type: 'error', gameId: 'g1', code: 'tooMany', message: 'x' }
    ])
    now += TYPING_INTERVAL_MS
    socket.close()
  })

  it('throws for a relative base with no page before listening', function () {
    const socket = new GameSocket({
      baseUrl: '/api/v1',
      pageHref: undefined,
      WebSocketImpl: FakeSocket
    })
    expect(() => socket.onChat(() => undefined)).throws(/relative/)
  })
})
