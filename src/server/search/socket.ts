import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'

import { asObject, asOptional } from 'cleaners'
import ipaddr from 'ipaddr.js'
import type { Kysely } from 'kysely'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'

import { HttpError } from '../../common/errors'
import {
  askOfFrame,
  asSearchFrame,
  asSeq,
  SEARCH_FRAME_MAX_BYTES,
  SEARCH_SOCKET_PATH,
  type SearchErrorCode,
  type SearchFrame,
  type SearchServerFrame
} from '../../common/search/types'
import { type Actor, actorForToken } from '../auth/sessions'
import { bearerToken, sessionToken } from '../auth/tokens'
import { type Database, isConnectionUnavailable } from '../db/database'
import type { IpLookup, IpPlace } from '../location/ipPlaces'
import type { UpgradeClaim } from '../socket/bindUpgrades'
import { apiSocketPath as pathOf } from '../socket/upgradePaths'
import {
  asksAnything,
  type SearchContext,
  type SearchDeps,
  searchJev,
  searchOnce
} from './engine'
import { type ReaderCache, readerCache, warmReader } from './readerCache'
import { ipPoint, type ReaderPoint, readerPoints } from './readerPlace'

/**
 * `WS /api/v1/search` — the search field's socket.
 *
 * Anybody may open it: a session token (bearer header or session cookie)
 * makes the reader that person, and no token, or one that resolves to
 * nobody, makes them signed out. A browser page whose `Origin` is not one of
 * `allowedOrigins` is refused with 403 before any session is read, so
 * another site cannot search with the reader's cookie.
 *
 * Each `search` frame is answered with the lexicographic `results`, one
 * search at a time: a frame that arrives while a search runs waits, and
 * replaces any frame already waiting, so when the search ends only the
 * newest frame is searched. A search whose frame a newer one has replaced
 * sends nothing. `JEV_DELAY_MS` after the last frame, the socket asks Jev to
 * re-rank that frame's candidates and, if Jev answers before a newer frame
 * arrives, sends the `jev` results for it. A newer frame, or the socket
 * closing, aborts the Jev call. An answer is never sent once a newer frame's
 * answer has gone.
 *
 * A signed-in socket's session is read again with every frame; once it no
 * longer answers as the same person, the socket is closed with 4401. An
 * upgrade whose bearer token signs nobody in is closed with 4401 at once;
 * one with no token, or with a session cookie that signs nobody in, is
 * signed out.
 *
 * Each socket keeps what its searches read about the reader alone
 * (`readerCache`, at most `READER_CACHE_MS`), starting those reads as a
 * signed-in socket opens, and forgets them once the session answers as
 * anybody else and when the socket closes.
 */

/** How long after the last `search` frame Jev is asked. */
export const JEV_DELAY_MS = 1000

/** The close code for a session that no longer signs anybody in. */
export const SIGNED_OUT_CLOSE = 4401

/**
 * The most bytes a frame may carry before the socket is closed with 1009.
 * A frame between `SEARCH_FRAME_MAX_BYTES` and this is answered with a
 * `tooLarge` error and the socket stays open.
 */
const HARD_FRAME_MAX_BYTES = 4 * SEARCH_FRAME_MAX_BYTES

export interface SearchSocketOptions {
  /** Charge a search shared with this caller’s other sockets and HTTP requests. */
  spendSearch?: (
    ip: string | null,
    userId: string | undefined,
    socket: object
  ) => Promise<number>
  db: Kysely<Database>
  deps: SearchDeps
  /**
   * The pages that may open the socket, checked against a browser's
   * `Origin` as the dictation socket checks it. A request with no `Origin`
   * (the phone, a script) is admitted. Absent, any origin is admitted.
   */
  allowedOrigins?: readonly string[]
  /** `JEV_DELAY_MS` by default; shortened in tests. */
  jevDelayMs?: number
  /** How often to ping. A socket that misses two is closed. */
  pingMs?: number
  log?: (message: string) => void
  /**
   * Where an IP address is (`startIpPlaces`): a reader with no placed
   * group of their own is ranked near their connection's address. Absent,
   * they are ranked near nowhere.
   */
  ipPlaces?: IpLookup
}

const unmapped = (address: string): string =>
  isIP(address) === 0 ? address : ipaddr.process(address).toString()

const isLoopback = (address: string): boolean =>
  isIP(address) !== 0 && ipaddr.process(address).range() === 'loopback'

/**
 * The client's address for an upgrade, as Express's `trust proxy:
 * 'loopback'` reads a request's: the socket's own, or, when that is the
 * proxy on this machine, the right-most `X-Forwarded-For` entry it did not
 * add itself. Null with none.
 */
export function upgradeClientIp(request: IncomingMessage): string | null {
  const remote = request.socket.remoteAddress
  if (remote == null) return null
  const direct = unmapped(remote)
  if (!isLoopback(direct)) return direct
  const header = request.headers['x-forwarded-for']
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map(entry => unmapped(entry.trim()))
    .filter(entry => entry !== '')
  for (let at = forwarded.length - 1; at >= 0; --at)
    if (!isLoopback(forwarded[at])) return forwarded[at]
  return forwarded[0] ?? direct
}

export interface SearchSocketHandle {
  /** The claim for `bindUpgrades`: takes only `/api/v1/search`. */
  acceptUpgrade: UpgradeClaim
  /** How many sockets are open. */
  size: () => number
  /** Closes every socket with 1001 and stops answering. */
  close: () => void
}

/** A frame waiting for the search before it to end. */
interface Waiting {
  frame: SearchFrame
  arrival: number
  /** Settles with the frame's search, or with null once it is replaced. */
  settle: (context: SearchContext | null) => void
}

/** One open search socket. */
interface Connection {
  socket: object
  ip: string | null
  ws: WebSocket
  /** The session token it opened with; null when signed out. */
  token: string | null
  actor: Actor | null
  /** What its searches read about `actor` alone, kept between them. */
  reader: ReaderCache
  /** `deps`, with `reader`. */
  deps: SearchDeps
  /** How many frames have arrived, numbering each as it does. */
  arrived: number
  /** The arrival number of the newest frame whose answer has been sent. */
  answered: number
  jevTimer: ReturnType<typeof setTimeout> | undefined
  jevAbort: AbortController | undefined
  /** Whether a search is running. */
  searching: boolean
  /** The newest frame that arrived while it was. */
  waiting: Waiting | undefined
  missed: number
}

export function attachSearchSocket(
  options: SearchSocketOptions
): SearchSocketHandle {
  const { db, deps } = options
  const jevDelayMs = options.jevDelayMs ?? JEV_DELAY_MS
  const log =
    options.log ??
    ((message: string) => {
      console.error(message)
    })
  const connections = new Set<Connection>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: HARD_FRAME_MAX_BYTES
  })

  const send = (connection: Connection, frame: SearchServerFrame): void => {
    if (connection.ws.readyState !== connection.ws.OPEN) return
    connection.ws.send(JSON.stringify(frame), { binary: false })
  }

  const refuse = (
    connection: Connection,
    code: SearchErrorCode,
    message: string,
    seq?: number
  ): void => {
    send(connection, {
      type: 'error',
      ...(seq == null ? {} : { seq }),
      code,
      message
    })
  }

  /** Stops the pending Jev call and its timer, if any. */
  const cancelJev = (connection: Connection): void => {
    if (connection.jevTimer != null) clearTimeout(connection.jevTimer)
    connection.jevTimer = undefined
    connection.jevAbort?.abort()
    connection.jevAbort = undefined
  }

  /**
   * Whether the session still signs in the same person. Signed out, there is
   * nothing to check. When it does not, the socket is closed with 4401.
   */
  const stillSignedIn = async (connection: Connection): Promise<boolean> => {
    if (connection.token == null || connection.actor == null) return true
    const actor = await actorForToken(db, connection.token, {
      recordUse: false
    })
    if (actor?.userId !== connection.actor.userId) {
      connection.reader.clear()
      cancelJev(connection)
      connection.ws.close(SIGNED_OUT_CLOSE, 'Sign in again')
      return false
    }
    connection.actor = actor
    return true
  }

  const failed = (
    connection: Connection,
    seq: number,
    error: unknown
  ): void => {
    if (
      error instanceof HttpError &&
      (error.code === 'notFound' ||
        error.code === 'forbidden' ||
        error.code === 'badRequest')
    ) {
      refuse(connection, error.code, error.message, seq)
      return
    }
    log(`search socket: search ${seq}: ${String(error)}`)
    refuse(
      connection,
      'internal',
      'The server could not search; try again',
      seq
    )
  }

  /** Asks Jev for this frame's ranking, unless a newer frame came first. */
  const rankLater = (
    connection: Connection,
    frame: SearchFrame,
    arrival: number,
    once: Promise<SearchContext | null>
  ): void => {
    const abort = new AbortController()
    connection.jevAbort = abort
    connection.jevTimer = setTimeout(() => {
      connection.jevTimer = undefined
      const latest = (): boolean =>
        !abort.signal.aborted && connection.arrived === arrival
      const rank = async (): Promise<void> => {
        const context = await once
        if (context == null || !latest()) return
        const ranked = await searchJev(
          db,
          connection.actor,
          askOfFrame(frame),
          context,
          connection.deps,
          abort.signal
        )
        if (ranked == null || !latest() || connection.answered > arrival) return
        connection.answered = arrival
        send(connection, {
          type: 'results',
          seq: frame.seq,
          stage: 'jev',
          results: ranked.results,
          locations: ranked.locations
        })
      }
      rank().catch((error: unknown) => {
        log(`search socket: jev ${frame.seq}: ${String(error)}`)
      })
    }, jevDelayMs)
  }

  const search = async (
    connection: Connection,
    frame: SearchFrame,
    arrival: number
  ): Promise<SearchContext | null> => {
    if (
      !(await stillSignedIn(connection)) ||
      connection.ws.readyState !== connection.ws.OPEN
    )
      return null
    const wait = await options.spendSearch?.(
      connection.ip,
      connection.actor?.userId,
      connection.socket
    )
    if (wait != null && wait > 0) {
      cancelJev(connection)
      connection.waiting?.settle(null)
      connection.waiting = undefined
      connection.ws.close(1013, `Try again in ${wait} seconds`)
      return null
    }
    if (connection.ws.readyState !== connection.ws.OPEN) return null
    const answer = await searchOnce(
      db,
      connection.actor,
      askOfFrame(frame),
      connection.deps
    )
    // A newer frame is waiting: this answer is already out of date.
    if (connection.arrived !== arrival || connection.answered > arrival)
      return answer.context
    connection.answered = arrival
    send(connection, {
      type: 'results',
      seq: frame.seq,
      stage: 'lexicographic',
      results: answer.results,
      locations: answer.locations
    })
    return answer.context
  }

  const received = (
    connection: Connection,
    data: RawData,
    isBinary: boolean
  ): void => {
    if (connection.ws.readyState !== connection.ws.OPEN) return
    const bytes = byteLength(data)
    if (bytes > SEARCH_FRAME_MAX_BYTES) {
      refuse(
        connection,
        'tooLarge',
        `A frame may carry at most ${SEARCH_FRAME_MAX_BYTES} bytes`
      )
      return
    }
    if (isBinary) {
      refuse(connection, 'malformed', 'Expected a JSON text frame')
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(rawText(data))
    } catch {
      refuse(connection, 'malformed', 'Expected a JSON text frame')
      return
    }
    let frame: SearchFrame
    try {
      frame = asSearchFrame(raw)
    } catch (error: unknown) {
      refuse(
        connection,
        'malformed',
        `Expected a search frame: ${messageOf(error)}`.slice(0, 300),
        seqOf(raw)
      )
      return
    }
    const arrival = ++connection.arrived
    cancelJev(connection)
    const once = new Promise<SearchContext | null>(resolve => {
      connection.waiting?.settle(null)
      connection.waiting = { frame, arrival, settle: resolve }
    })
    if (!connection.searching) next(connection)
    // An empty field with no pill asks Jev nothing.
    if (asksAnything(frame)) rankLater(connection, frame, arrival, once)
  }

  /** Searches the waiting frame, and then whichever waits after it. */
  const next = (connection: Connection): void => {
    const waiting = connection.waiting
    if (waiting == null || connection.ws.readyState !== connection.ws.OPEN)
      return
    connection.waiting = undefined
    connection.searching = true
    const { frame, arrival, settle } = waiting
    search(connection, frame, arrival)
      .catch((error: unknown) => {
        if (connection.arrived === arrival) failed(connection, frame.seq, error)
        return null
      })
      .then(context => {
        settle(context)
        connection.searching = false
        next(connection)
      })
      .catch((error: unknown) => {
        log(`search socket: search ${frame.seq}: ${String(error)}`)
      })
  }

  const connected = (
    ws: WebSocket,
    actor: Actor | null,
    token: string | null,
    ip: string | null,
    socket: object
  ): void => {
    const reader = readerCache()
    // The reader's own places are read once for the connection, whose
    // reader never changes (a sign-in as someone else closes it). The
    // address's place is kept once found; no answer (none, or none in time
    // from the primary) is asked again by the next search. The address is
    // only looked up, never logged or written anywhere.
    let own: Promise<ReaderPoint[]> | undefined
    let place: IpPlace | null = null
    const pointsOf = async (): Promise<ReaderPoint[]> => {
      own ??= readerPoints(
        db,
        connection.actor == null
          ? null
          : async () => await reader.of(db, connection.actor!).reach(),
        () => null
      )
      // A failed read is read again by the next search.
      own.catch(() => {
        own = undefined
      })
      const groups = await own
      if (groups.length > 0 || ip == null) return groups
      place ??= (await options.ipPlaces?.lookup(ip)) ?? null
      return place == null ? [] : [ipPoint(place)]
    }
    const connection: Connection = {
      socket,
      ip,
      ws,
      token,
      actor,
      reader,
      deps: { ...deps, reader, readerPoints: pointsOf },
      arrived: 0,
      answered: 0,
      jevTimer: undefined,
      jevAbort: undefined,
      searching: false,
      waiting: undefined,
      missed: 0
    }
    connections.add(connection)
    // A signed-in reader's own reads start as the socket opens.
    if (actor != null) warmReader(reader.of(db, actor))
    ws.on('pong', () => {
      connection.missed = 0
    })
    ws.on('message', (data, isBinary) => {
      received(connection, data, isBinary)
    })
    ws.on('error', () => undefined)
    ws.on('close', () => {
      connections.delete(connection)
      connection.reader.clear()
      cancelJev(connection)
      connection.waiting?.settle(null)
      connection.waiting = undefined
    })
  }

  const acceptUpgrade: UpgradeClaim = (request, socket, head) => {
    if (pathOf(request.url) !== SEARCH_SOCKET_PATH) return false
    socket.on('error', () => undefined)
    if (!originAllowed(request, options.allowedOrigins)) {
      refuseUpgrade(socket, 403, 'Forbidden')
      return true
    }
    const bearer = bearerToken(request.headers.authorization) != null
    const token =
      sessionToken(request.headers.authorization, request.headers.cookie) ??
      null
    const ip = upgradeClientIp(request)
    const actor: Promise<Actor | undefined> =
      token == null ? Promise.resolve(undefined) : actorForToken(db, token)
    actor.then(
      found => {
        wss.handleUpgrade(request, socket, head, ws => {
          if (found != null) connected(ws, found, token, ip, socket)
          // A bearer token that signs nobody in (expired, or revoked before
          // the socket opened) is refused: the client is told to sign in
          // again. A session cookie that signs nobody in is read as signed
          // out, as `withActor` reads it: the browser keeps a revoked
          // cookie it cannot clear, and its reader is signed out.
          else if (bearer) ws.close(SIGNED_OUT_CLOSE, 'Sign in again')
          else connected(ws, null, null, ip, socket)
        })
      },
      (error: unknown) => {
        log(`search socket: signing in an upgrade: ${String(error)}`)
        if (isConnectionUnavailable(error))
          refuseUpgrade(
            socket,
            503,
            'Service Unavailable',
            'Retry-After: 1\r\n'
          )
        else refuseUpgrade(socket, 500, 'Internal Server Error')
      }
    )
    return true
  }

  // Two missed pings and the socket is gone: a phone that walked away never
  // says goodbye.
  const pinger = setInterval(() => {
    for (const connection of connections) {
      if (connection.missed >= 2) {
        connection.ws.terminate()
        continue
      }
      connection.missed++
      connection.ws.ping()
    }
  }, options.pingMs ?? 30_000)
  // Node's timer; the app's DOM types read it as a number.
  ;(pinger as { unref?: () => void }).unref?.()

  return {
    acceptUpgrade,
    size: () => connections.size,
    close: () => {
      clearInterval(pinger)
      for (const connection of connections) {
        cancelJev(connection)
        connection.ws.close(1001, 'The server is restarting')
      }
      wss.close()
    }
  }
}

function originAllowed(
  request: IncomingMessage,
  allowedOrigins: readonly string[] | undefined
): boolean {
  const origin = request.headers.origin
  if (origin == null || allowedOrigins == null) return true
  const bare = (url: string): string => url.replace(/\/+$/, '')
  return allowedOrigins.some(allowed => bare(allowed) === bare(origin))
}

function refuseUpgrade(
  socket: Duplex,
  status: number,
  text: string,
  headers = ''
): void {
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\n${headers}Connection: close\r\nContent-Length: 0\r\n\r\n`
  )
}

function byteLength(data: RawData): number {
  if (Array.isArray(data))
    return data.reduce((total, part) => total + part.length, 0)
  return data instanceof ArrayBuffer ? data.byteLength : data.length
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

const asNumbered = asObject({ seq: asOptional(asSeq) })

/** A malformed frame's `seq`, when it carries a readable one. */
function seqOf(raw: unknown): number | undefined {
  try {
    return asNumbered(raw).seq
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
