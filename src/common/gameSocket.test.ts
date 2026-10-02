import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  GameSocket,
  type GameSocketEvent,
  RECONNECT_DELAYS_MS,
  RESUBSCRIBE_DELAYS_MS,
  socketUrl,
  type WebSocketLike
} from './gameSocket'

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

  drop(): void {
    this.onclose?.({})
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

function makeSocket(options: { token?: string; baseUrl?: string } = {}): {
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
    clearTimer: timers.clearTimer
  })
  return { socket, timers }
}

const last = (): FakeSocket => FakeSocket.made[FakeSocket.made.length - 1]

/** U16: the shared client, against a fake WebSocket. */
describe('GameSocket (U16)', function () {
  describe('its address', function () {
    it('turns http into ws and https into wss, on the same host and port', function () {
      expect(socketUrl('http://10.10.7.40:9100/api/v1')).equals(
        'ws://10.10.7.40:9100/socket'
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
        { type: 'subscribe', gameId: 'g1', id: 'c1' },
        { type: 'subscribe', gameId: 'g2', id: 'c2' }
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
        { type: 'subscribe', gameId: 'g1', id: 'c3' },
        { type: 'subscribe', gameId: 'g2', id: 'c4' }
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
      last().receive({ kind: 'plays' })
      last().receive({ type: 'error', code: 'unknown', message: 'x' })
      last().receive({ ...change, gameId: 'g9' })
      expect(one).deep.equals([change, { type: 'subscribed', gameId: 'g1' }])
      expect(two).deep.equals([])
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
        kind: 'plays',
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
          id: `c${i}`
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
        { type: 'subscribe', gameId: 'g1', id: 'c2' }
      ])
      last().receive(internal('c2'))
      expect(timers.pending()).equals(1)
      socket.close()
      expect(timers.pending()).equals(0)
    })

    it('asks once, when another subscribe for the game is already out', function () {
      const { socket, timers } = makeSocket()
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
})
