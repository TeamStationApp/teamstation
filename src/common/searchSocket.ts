import {
  RECONNECT_DELAYS_MS,
  socketUrl,
  type WebSocketConstructor,
  type WebSocketLike
} from './gameSocket'
import {
  type Location,
  SEARCH_SOCKET_PATH,
  type SearchAsk,
  type SearchErrorFrame,
  type SearchFrame,
  type SearchResult,
  searchServerFrameOf,
  type SearchStage
} from './search/types'

/**
 * The search field's end of `WS /api/v1/search` (`server/search/socket.ts`).
 *
 * `search` sends the ask at once, numbered by a `seq` that only grows, and
 * the socket keeps the latest one. An answer for an older `seq` never
 * reaches `onResults`: typing that has been overtaken cannot replace what
 * the field now asks. A dropped socket reconnects after 1, 2, 4 and 8
 * seconds and then every 15 (`RECONNECT_DELAYS_MS`), and sends the current
 * ask again, under a new `seq`, once it is open.
 *
 * Its status is `connecting` until the first connection opens, `open` while
 * one is, and `offline` from the moment one drops or fails until the next
 * opens.
 *
 * A socket the server closes with `SEARCH_SIGNED_OUT_CLOSE` (4401: the
 * session it signed in with is no good) is `unauthorized`: it never
 * connects again with that token. It reads `token` every
 * `TOKEN_CHECK_MS`, and on each `search`, and connects again once it
 * gives another (a new sign-in, or none: signed out).
 */

export type SearchSocketStatus =
  'connecting' | 'open' | 'offline' | 'unauthorized'

/** The close code of a socket whose session the server no longer accepts. */
export const SEARCH_SIGNED_OUT_CLOSE = 4401

/** How often an `unauthorized` socket reads its token for a new one. */
export const TOKEN_CHECK_MS = 1000

/** One answer, for the latest search. */
export interface SearchSocketResults {
  seq: number
  stage: SearchStage
  results: SearchResult[]
  locations: Location[]
}

export interface SearchSocketOptions {
  /** The socket's address: `ws:` or `wss:`, ending `/api/v1/search`. */
  url: string
  /**
   * The session token, where the platform has no cookie (a phone), read
   * afresh for each connection. Null or absent searches as signed out, or by
   * the browser's cookie.
   */
  token?: () => string | null
  WebSocketImpl?: WebSocketConstructor
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  /**
   * Where a frame or a row it cannot read is reported; `console.warn` by
   * default.
   */
  log?: (line: string) => void
}

/**
 * The search socket's address for an API base URL, resolved against the page
 * when it is relative, as the game socket's is.
 */
export function searchSocketUrl(baseUrl: string, pageHref?: string): string {
  return socketUrl(baseUrl, pageHref).replace(/\/socket$/, SEARCH_SOCKET_PATH)
}

export class SearchSocket {
  private readonly url: string
  private readonly token: () => string | null
  private readonly WebSocketImpl: WebSocketConstructor | undefined
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly log: (line: string) => void
  private readonly resultListeners = new Set<
    (results: SearchSocketResults) => void
  >()

  private readonly errorListeners = new Set<(error: SearchErrorFrame) => void>()

  private readonly statusListeners = new Set<
    (status: SearchSocketStatus) => void
  >()

  private socket: WebSocketLike | undefined
  private state: SearchSocketStatus = 'connecting'
  private closed = false
  private attempt = 0
  private rateLimited = false
  private timer: unknown
  /** The ask the field shows now, sent again after a reconnect. */
  private current: SearchAsk | undefined
  /** The last `seq` sent. */
  private seq = 0
  /** The token the open (or opening) connection signed in with. */
  private signedWith: string | null = null

  /** Connects at once. */
  constructor(options: SearchSocketOptions) {
    this.url = options.url
    this.token = options.token ?? (() => null)
    this.WebSocketImpl = options.WebSocketImpl
    this.setTimer =
      options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms))
    this.clearTimer =
      options.clearTimer ??
      (timer => {
        globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)
      })
    this.log =
      options.log ??
      (line => {
        console.warn(line)
      })
    this.connect()
  }

  get status(): SearchSocketStatus {
    return this.state
  }

  /** The latest `seq` sent, or 0 before the first. */
  get latestSeq(): number {
    return this.seq
  }

  /**
   * Asks this, now if the socket is open and else once it opens, and returns
   * its `seq`. Every earlier ask's answers are dropped from here on.
   */
  search(ask: SearchAsk): number {
    this.current = { ...ask }
    this.seq++
    if (this.state === 'unauthorized') this.checkToken()
    else this.sendCurrent()
    return this.seq
  }

  /** Hears each answer for the latest search. Returns the way to stop. */
  onResults(listener: (results: SearchSocketResults) => void): () => void {
    this.resultListeners.add(listener)
    return () => {
      this.resultListeners.delete(listener)
    }
  }

  /**
   * Hears the server refuse the latest search, or a frame it could not
   * number. Returns the way to stop.
   */
  onError(listener: (error: SearchErrorFrame) => void): () => void {
    this.errorListeners.add(listener)
    return () => {
      this.errorListeners.delete(listener)
    }
  }

  /** Hears each change of status. Returns the way to stop. */
  onStatus(listener: (status: SearchSocketStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /** Closes the socket for good. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer != null) this.clearTimer(this.timer)
    this.timer = undefined
    const socket = this.socket
    this.socket = undefined
    if (socket != null) {
      this.detach(socket)
      socket.close(1000, 'closed')
    }
    this.setStatus('offline')
    this.resultListeners.clear()
    this.errorListeners.clear()
    this.statusListeners.clear()
  }

  private sendCurrent(): void {
    if (this.state !== 'open' || this.socket == null || this.current == null)
      return
    const frame: SearchFrame = {
      type: 'search',
      seq: this.seq,
      ...this.current
    }
    this.socket.send(JSON.stringify(frame))
  }

  private connect(): void {
    this.timer = undefined
    if (this.closed) return
    const Impl =
      this.WebSocketImpl ??
      (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
    if (Impl == null) throw new Error('This platform has no WebSocket')
    const token = this.token()
    this.signedWith = token
    const socket =
      token == null
        ? new Impl(this.url)
        : new Impl(this.url, undefined, {
            headers: { Authorization: `Bearer ${token}` }
          })
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      if (!this.rateLimited) this.attempt = 0
      this.setStatus('open')
      // Whatever the last connection was asked, this one answers afresh.
      if (this.current != null) {
        this.seq++
        this.sendCurrent()
      }
    }
    socket.onmessage = event => {
      if (this.socket === socket) this.received(event.data)
    }
    // A browser reports a failure as `error` and then `close`; React Native
    // may report either alone. The first one reconnects.
    socket.onerror = () => {
      socket.close()
      this.dropped(socket)
    }
    socket.onclose = event => {
      const close = event as { code?: number; reason?: string } | null
      if (close?.code === SEARCH_SIGNED_OUT_CLOSE) this.refused(socket)
      else if (close?.code === 1013) {
        // The next handshake and the retried search each spend an aggregate
        // unit. Keep backing off until the server actually answers a search.
        const retry = /^Try again in (\d{1,6}) seconds$/.exec(
          close.reason ?? ''
        )
        this.rateLimited = true
        this.dropped(socket, retry == null ? 0 : Number(retry[1]) * 2000)
      } else this.dropped(socket)
    }
  }

  /**
   * The server no longer accepts the session this socket signed in with:
   * no reconnect with it, only with a token `token` gives that differs.
   */
  private refused(socket: WebSocketLike): void {
    if (this.socket !== socket) return
    this.detach(socket)
    this.socket = undefined
    if (this.closed) return
    if (this.timer != null) this.clearTimer(this.timer)
    this.setStatus('unauthorized')
    this.watchToken()
  }

  private watchToken(): void {
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.checkToken()
    }, TOKEN_CHECK_MS)
  }

  /** Connects again once the token differs from the one refused. */
  private checkToken(): void {
    // A connection on its way with a new token is answered by the server.
    if (this.closed || this.state !== 'unauthorized' || this.socket != null)
      return
    if (this.token() === this.signedWith) {
      if (this.timer == null) this.watchToken()
      return
    }
    if (this.timer != null) this.clearTimer(this.timer)
    this.attempt = 0
    this.connect()
  }

  private dropped(socket: WebSocketLike, retryMs = 0): void {
    if (this.socket !== socket) return
    this.detach(socket)
    this.socket = undefined
    if (this.closed) return
    this.setStatus('offline')
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)
      ]
    this.attempt++
    this.timer = this.setTimer(
      () => {
        this.connect()
      },
      Math.max(delay, retryMs)
    )
  }

  private detach(socket: WebSocketLike): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
  }

  private received(data: unknown): void {
    if (typeof data !== 'string') return
    let frame
    try {
      // A row the client cannot read is left out, and the rest shown.
      frame = searchServerFrameOf(
        JSON.parse(data),
        ({ list, index, error }) => {
          this.log(`search: left out ${list}[${index}]: ${String(error)}`)
        }
      )
    } catch (error) {
      this.log(`search: unreadable frame: ${String(error)}`)
      return
    }
    this.rateLimited = false
    this.attempt = 0
    if (frame.type === 'error') {
      if (frame.seq != null && frame.seq !== this.seq) return
      for (const listener of [...this.errorListeners]) listener(frame)
      return
    }
    if (frame.seq !== this.seq) return
    const results: SearchSocketResults = {
      seq: frame.seq,
      stage: frame.stage,
      results: frame.results,
      locations: frame.locations
    }
    for (const listener of [...this.resultListeners]) listener(results)
  }

  private setStatus(status: SearchSocketStatus): void {
    if (this.state === status) return
    this.state = status
    for (const listener of [...this.statusListeners]) listener(status)
  }
}
