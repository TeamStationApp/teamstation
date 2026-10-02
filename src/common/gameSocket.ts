import { asObject, asOptional, asString, type Cleaner } from 'cleaners'

import type { TeamLineups } from './api'
import { asLiteral } from './asLiteral'
import type { WalkUpSong } from './walkUpSong'

/**
 * A game's changes, as they happen, over one WebSocket at `/socket`.
 *
 * The server end is `server/socket/gameSocket.ts`. A screen subscribes to a
 * game and is sent a `change` whenever that game's plays, lineups, score or a
 * player's walk-up song change. Nothing here is the record: a message is a
 * nudge with the new data attached, and after a reconnect the screen is sent
 * `resync` and reads the game again over REST, because whatever changed while
 * the socket was down was never sent.
 */

/** What a `change` is about. */
export type GameChangeKind = 'plays' | 'lineups' | 'walkUpSong' | 'game'

/** The `data` of each kind of change. */
export interface GameChangeData {
  /** The stored plays and the at-bat in progress, as `GET /events` answers. */
  plays: { plays: unknown[]; currentPlay: unknown }
  /** Both sides' lineups, as `GET /games/:gameId/lineups` answers. */
  lineups: { home: TeamLineups; away: TeamLineups }
  /** One player's song on one team, or null once it is removed. */
  walkUpSong: { teamId: string; userId: number; song: WalkUpSong | null }
  game: {
    status: 'scheduled' | 'inProgress' | 'final' | 'cancelled'
    awayScore: number | null
    homeScore: number | null
  }
}

export type GameChange = {
  [K in GameChangeKind]: {
    type: 'change'
    gameId: string
    kind: K
    /** When the server read the data. */
    at: string
    data: GameChangeData[K]
  }
}[GameChangeKind]

/**
 * Why a request was refused. `internal` is the server failing (its database
 * down or out of connections), not the request: asking again may work.
 */
export type GameSocketErrorCode =
  'notFound' | 'malformed' | 'tooMany' | 'internal'

/** What a subscriber hears. */
export type GameSocketEvent =
  | GameChange
  /** Messages may have been missed: read the game again. */
  | { type: 'resync'; gameId: string }
  /** The server confirmed it hears this game now. */
  | { type: 'subscribed'; gameId: string }
  | {
      type: 'error'
      gameId: string
      code: GameSocketErrorCode
      message: string
    }

export type GameSocketListener = (event: GameSocketEvent) => void

/** A frame the client sends. */
export type GameSocketRequest =
  | { type: 'subscribe'; gameId: string; id: string }
  | { type: 'unsubscribe'; gameId: string; id: string }
  | { type: 'ping'; id: string }

/** A frame the server sends. */
export type GameSocketReply =
  | GameChange
  | { type: 'subscribed'; gameId: string; id: string }
  | { type: 'unsubscribed'; gameId: string; id: string }
  | { type: 'pong'; id: string }
  | {
      type: 'error'
      id?: string
      gameId?: string
      code: GameSocketErrorCode
      message: string
    }

/** The part of a WebSocket this client uses, on the web and in React Native. */
export interface WebSocketLike {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

/**
 * The constructor. React Native's takes the headers as a third argument; a
 * browser's has no such argument and sends the session cookie instead.
 */
export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers: Record<string, string> }
) => WebSocketLike

/** How long to wait before each reconnect, then the last one for ever. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

/**
 * How long to wait before asking again for a game the server failed to
 * subscribe (`internal`), then the last one for ever.
 */
export const RESUBSCRIBE_DELAYS_MS = RECONNECT_DELAYS_MS

/**
 * The socket's address, from the API's base URL.
 *
 * The base is resolved against the page first, so the deployed web bundle's
 * relative `/api/v1` becomes the page's own origin, while a phone's absolute
 * URL stands as it is. Then `http` becomes `ws` and `https` `wss`, on the
 * same host and port, at `/socket`. A relative base with nothing to resolve
 * it against is an error, rather than a socket that connects to nothing.
 */
export function socketUrl(baseUrl: string, pageHref?: string): string {
  let url: URL
  try {
    url = new URL(baseUrl, pageHref)
  } catch {
    throw new Error(
      `The game socket cannot be found from the API address "${baseUrl}": ` +
        'it is relative and there is no page to resolve it against.'
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `The game socket cannot be found from the API address "${baseUrl}": ` +
        'it is not an http or https address.'
    )
  }
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/socket`
}

const asReplyHead = asObject({
  type: asString,
  id: asOptional(asString),
  gameId: asOptional(asString)
})

const asErrorReply = asObject({
  type: asLiteral('error'),
  id: asOptional(asString),
  gameId: asOptional(asString),
  code: asLiteral(
    'notFound',
    'malformed',
    'tooMany',
    'internal'
  ) as Cleaner<GameSocketErrorCode>,
  message: asString
})

const asChangeHead = asObject({
  type: asLiteral('change'),
  gameId: asString,
  kind: asLiteral(
    'plays',
    'lineups',
    'walkUpSong',
    'game'
  ) as Cleaner<GameChangeKind>,
  at: asString
})

/** A game being asked for again: how many times, and the wait now set. */
interface Retry {
  attempt: number
  timer: unknown
}

export interface GameSocketOptions {
  /** The API's base URL, as the client is given it. */
  baseUrl: string
  /** The session token, where the platform has no cookie (a phone). */
  token?: string
  WebSocketImpl?: WebSocketConstructor
  /** The page's address, for a relative `baseUrl`. The page's by default. */
  pageHref?: string
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/**
 * One socket for the whole app, shared by every screen that wants a game's
 * changes. It connects when the first game is subscribed, reconnects after
 * 1, 2, 4 and 8 seconds and then every 15, and after each reconnect
 * subscribes every game again and tells its listeners to `resync`.
 *
 * A subscribe the server refuses as `internal` (its own failure) is asked
 * again on the same timings, for as long as the game is still wanted and the
 * socket stays up, until the server answers `subscribed`. Listeners hear the
 * `error`, and later the `subscribed`.
 */
export class GameSocket {
  private readonly baseUrl: string
  private readonly pageHref: string | undefined
  private readonly token: string | undefined
  private readonly WebSocketImpl: WebSocketConstructor | undefined
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly listeners = new Map<string, Set<GameSocketListener>>()
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  /** Which game each outstanding subscribe was for, by its id. */
  private readonly requests = new Map<string, string>()
  /** Games waiting to be asked again after `internal`, by game. */
  private readonly retries = new Map<string, Retry>()
  private socket: WebSocketLike | undefined
  private open = false
  private closed = false
  /** Set once a connection has been lost or refused. */
  private interrupted = false
  private attempt = 0
  private timer: unknown
  private nextId = 1

  /**
   * Nothing is resolved until the first subscribe, so making one where it
   * will never be used (a test, a screen with no live data) costs nothing and
   * cannot fail.
   */
  constructor(options: GameSocketOptions) {
    this.baseUrl = options.baseUrl
    this.pageHref = options.pageHref
    this.token = options.token
    this.WebSocketImpl = options.WebSocketImpl
    this.setTimer =
      options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms))
    this.clearTimer =
      options.clearTimer ??
      (timer => {
        globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)
      })
  }

  /**
   * The socket's address, from the API's base URL and the page. Throws when
   * there is none to be had.
   */
  get url(): string {
    const page = (globalThis as { location?: { href?: string } }).location
    return socketUrl(this.baseUrl, this.pageHref ?? page?.href)
  }

  /** Whether the socket is connected now. */
  get connected(): boolean {
    return this.open
  }

  /** Hears the socket connect and drop. Returns the way to stop hearing. */
  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /**
   * Hears one game's changes. The first listener for a game subscribes it,
   * and removing the last one unsubscribes it.
   */
  subscribe(gameId: string, listener: GameSocketListener): () => void {
    if (this.closed) throw new Error('This game socket is closed')
    // Before anything is kept, so a platform that cannot connect says so.
    if (this.socket == null && this.timer == null) this.endpoint()
    let set = this.listeners.get(gameId)
    if (set == null) {
      set = new Set()
      this.listeners.set(gameId, set)
      if (this.open) this.request('subscribe', gameId)
    }
    set.add(listener)
    if (this.socket == null && this.timer == null) this.connect()
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      const current = this.listeners.get(gameId)
      if (current == null) return
      current.delete(listener)
      if (current.size > 0) return
      this.listeners.delete(gameId)
      this.stopRetry(gameId)
      if (this.open) this.request('unsubscribe', gameId)
    }
  }

  /** Closes the socket for good. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer != null) this.clearTimer(this.timer)
    this.timer = undefined
    this.stopRetries()
    const socket = this.socket
    this.socket = undefined
    this.listeners.clear()
    if (socket != null) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close(1000, 'closed')
    }
    this.setOpen(false)
  }

  private endpoint(): { url: string; Impl: WebSocketConstructor } {
    const url = this.url
    const Impl =
      this.WebSocketImpl ??
      (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
    if (Impl == null) throw new Error('This platform has no WebSocket')
    return { url, Impl }
  }

  private connect(): void {
    this.timer = undefined
    if (this.closed) return
    const { url, Impl } = this.endpoint()
    const socket =
      this.token == null
        ? new Impl(url)
        : new Impl(url, undefined, {
            headers: { Authorization: `Bearer ${this.token}` }
          })
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.requests.clear()
      this.setOpen(true)
      for (const gameId of this.listeners.keys())
        this.request('subscribe', gameId)
      if (this.interrupted) {
        for (const gameId of [...this.listeners.keys()])
          this.emit(gameId, { type: 'resync', gameId })
      }
    }
    socket.onmessage = event => {
      this.received(event.data)
    }
    // A browser reports a failure as `error` and then `close`; React Native
    // may report either alone. The close is what reconnects.
    socket.onerror = () => {
      socket.close()
      this.dropped(socket)
    }
    socket.onclose = () => {
      this.dropped(socket)
    }
  }

  private dropped(socket: WebSocketLike): void {
    if (this.socket !== socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    this.socket = undefined
    this.interrupted = true
    // The reconnect subscribes every game again.
    this.stopRetries()
    this.setOpen(false)
    if (this.closed) return
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)
      ]
    this.attempt++
    this.timer = this.setTimer(() => {
      this.connect()
    }, delay)
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return
    this.open = open
    for (const listener of [...this.statusListeners]) listener(open)
  }

  private request(type: 'subscribe' | 'unsubscribe', gameId: string): void {
    const id = `c${this.nextId++}`
    if (type === 'subscribe') this.requests.set(id, gameId)
    const frame: GameSocketRequest = { type, gameId, id }
    this.socket?.send(JSON.stringify(frame))
  }

  private received(data: unknown): void {
    if (typeof data !== 'string') return
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      return
    }
    let head: ReturnType<typeof asReplyHead>
    try {
      head = asReplyHead(raw)
    } catch {
      return
    }
    if (head.type === 'change') {
      let change: ReturnType<typeof asChangeHead>
      try {
        change = asChangeHead(raw)
      } catch {
        return
      }
      const message = { ...change, data: (raw as { data?: unknown }).data }
      this.emit(change.gameId, message as GameChange)
      return
    }
    if (head.type === 'subscribed' && head.id != null) {
      const gameId = this.requests.get(head.id)
      this.requests.delete(head.id)
      if (gameId == null) return
      this.stopRetry(gameId)
      this.emit(gameId, { type: 'subscribed', gameId })
      return
    }
    if (head.type !== 'error') return
    let error: ReturnType<typeof asErrorReply>
    try {
      error = asErrorReply(raw)
    } catch {
      return
    }
    const gameId =
      error.gameId ??
      (error.id == null ? undefined : this.requests.get(error.id))
    const asked = error.id == null ? undefined : this.requests.get(error.id)
    if (error.id != null) this.requests.delete(error.id)
    if (error.code === 'internal' && asked != null) this.retryLater(asked)
    const games = gameId == null ? [...this.listeners.keys()] : [gameId]
    for (const game of games)
      this.emit(game, {
        type: 'error',
        gameId: game,
        code: error.code,
        message: error.message
      })
  }

  /**
   * Asks again for a game the server failed to subscribe, after the next
   * delay, unless it is no longer wanted or another subscribe is already out.
   */
  private retryLater(gameId: string): void {
    if (!this.listeners.has(gameId)) return
    for (const game of this.requests.values()) if (game === gameId) return
    const retry = this.retries.get(gameId) ?? { attempt: 0, timer: undefined }
    if (retry.timer != null) return
    const delay =
      RESUBSCRIBE_DELAYS_MS[
        Math.min(retry.attempt, RESUBSCRIBE_DELAYS_MS.length - 1)
      ]
    retry.attempt++
    retry.timer = this.setTimer(() => {
      retry.timer = undefined
      if (this.open && this.listeners.has(gameId))
        this.request('subscribe', gameId)
    }, delay)
    this.retries.set(gameId, retry)
  }

  private stopRetry(gameId: string): void {
    const retry = this.retries.get(gameId)
    if (retry == null) return
    if (retry.timer != null) this.clearTimer(retry.timer)
    this.retries.delete(gameId)
  }

  private stopRetries(): void {
    for (const gameId of [...this.retries.keys()]) this.stopRetry(gameId)
  }

  private emit(gameId: string, event: GameSocketEvent): void {
    const set = this.listeners.get(gameId)
    if (set == null) return
    for (const listener of [...set]) listener(event)
  }
}
