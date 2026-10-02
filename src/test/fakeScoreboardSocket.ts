import type {
  Schedule,
  SocketConstructor,
  SocketLike
} from '../app/scoreboard/scoreboardSocket'

/**
 * A WebSocket and a clock the scoreboard clients' tests drive by hand: every
 * socket the client makes is kept in order, and the test opens, feeds and
 * closes each one as the server would.
 */
export class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  readyState = 0
  sent: string[] = []
  closedWith: number | undefined

  constructor(
    readonly url: string,
    /** The handshake's headers, where a phone would send them. */
    readonly headers?: Record<string, string>
  ) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    this.closedWith = code
    this.readyState = 3
    this.onclose?.({ code: code ?? 1000 })
  }

  /** The server accepts the connection. */
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  /** The server sends a message, as JSON unless it is already a string. */
  receive(message: unknown): void {
    this.onmessage?.({
      data: typeof message === 'string' ? message : JSON.stringify(message)
    })
  }

  /** The connection ends from the far side, or never opened. */
  drop(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }

  /** What the client has sent, parsed. */
  messages(): unknown[] {
    return this.sent.map(text => JSON.parse(text) as unknown)
  }
}

export function fakeSockets(): {
  Impl: SocketConstructor
  sockets: FakeSocket[]
  latest: () => FakeSocket
} {
  const sockets: FakeSocket[] = []
  class Impl extends FakeSocket {
    constructor(
      url: string,
      _protocols?: string | string[],
      options?: { headers: Record<string, string> }
    ) {
      super(url, options?.headers)
      sockets.push(this)
    }
  }
  return {
    Impl,
    sockets,
    latest: () => {
      const socket = sockets.at(-1)
      if (socket == null) throw new Error('no socket has been opened')
      return socket
    }
  }
}

/** A clock that moves only when the test says so. */
export function fakeClock(): {
  schedule: Schedule
  advance: (ms: number) => void
  pending: () => number
} {
  let now = 0
  let timers: Array<{ at: number; run: () => void }> = []
  return {
    schedule: (run, ms) => {
      const timer = { at: now + ms, run }
      timers.push(timer)
      return () => {
        timers = timers.filter(one => one !== timer)
      }
    },
    advance: ms => {
      now += ms
      const due = timers.filter(timer => timer.at <= now)
      timers = timers.filter(timer => timer.at > now)
      for (const timer of due) timer.run()
    },
    pending: () => timers.length
  }
}
