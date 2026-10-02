import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { asEither, asObject, asString, asValue } from 'cleaners'
import type { Kysely } from 'kysely'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'

import type {
  GameChange,
  GameSocketErrorCode,
  GameSocketReply
} from '../../common/gameSocket'
import {
  canSeeGame,
  type GameScope,
  type VisibleScopes,
  visibleScopes
} from '../access'
import { type Actor, actorForToken } from '../auth/sessions'
import { sessionToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { GameFanout, type GameFanoutOptions } from './fanout'

/** The one path the socket answers on. */
export const SOCKET_PATH = '/socket'
/** An inbound frame larger than this closes the socket with 1009. */
export const MAX_FRAME_BYTES = 4096
/** How many games one socket may be subscribed to at once. */
export const MAX_SUBSCRIPTIONS = 20

export interface GameSocketOptions {
  /** How often to ping. A socket that misses two is closed. */
  pingMs?: number
  /** How long a socket's visibility is trusted before it is read again. */
  recheckMs?: number
  /** In milliseconds, for the visibility check. */
  clock?: () => number
  /**
   * What stops the worker: every socket is closed with 1001 on SIGTERM or
   * SIGINT from it, so a restart does not wait on them and every client
   * reconnects to a worker that is still there. `process` unless given; null
   * for none.
   */
  stopSignals?: NodeJS.EventEmitter | null
  fanout?: Omit<GameFanoutOptions, 'db' | 'databaseUrl' | 'onLost'>
  /** Where a request that failed is reported. `console.error` unless given. */
  log?: (message: string) => void
  /**
   * Wraps each subscribe's visibility check, which `check` runs. For tests,
   * to make it fail; the check itself unless given.
   */
  checkGame?: (
    gameId: string,
    check: () => Promise<GameScope | undefined>
  ) => Promise<GameScope | undefined>
  /**
   * When false, nothing here listens for upgrades. The server calls
   * `acceptUpgrade` from the one listener every socket shares. Default
   * true: this is the only socket, and any other path is refused.
   */
  listenForUpgrades?: boolean
}

export interface GameSocketHandle {
  fanout: GameFanout
  /** How many sockets are open. */
  size: () => number
  /**
   * Takes a `/socket` upgrade. A path this socket does not own is left as it
   * arrived, so another socket on the same server can take it.
   */
  acceptUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean
  close: () => Promise<void>
}

const asRequest = asEither(
  asObject({
    type: asValue('subscribe', 'unsubscribe'),
    gameId: asString,
    id: asString
  }),
  asObject({ type: asValue('ping'), id: asString })
)

/** One open socket: who it is, what it has subscribed to, and its health. */
interface Connection {
  ws: WebSocket
  actor: Actor
  games: Set<string>
  /**
   * The games this socket holds places for under the cap, as of the last
   * request it sent: each maps to the subscribe that claimed it. A subscribe
   * claims its place when it arrives and an unsubscribe gives it back when it
   * arrives, even while the game's earlier requests are still being handled,
   * so the cap counts what the client asked for in the order sent.
   */
  claims: Map<string, number>
  /** Numbers each subscribe, so a claim is released only by its own. */
  sequence: number
  /**
   * Each game's last subscribe or unsubscribe still being handled. The next
   * one for that game waits on it, so they take effect in the order sent: an
   * unsubscribe right behind a subscribe undoes it rather than overtaking it.
   */
  turns: Map<string, Promise<void>>
  /** Pings sent since the last pong. */
  missed: number
  scopes: VisibleScopes | undefined
  scopesAt: number
  reading: Promise<VisibleScopes> | undefined
  subscriber: {
    send: (message: GameChange) => void
    maySee: (game: GameScope) => Promise<boolean>
  }
}

/**
 * Answers WebSocket upgrades on `/socket` on this worker's HTTP server.
 *
 * The upgrade is authenticated as a REST request is, by the bearer header or
 * the session cookie, and anything else is refused with 401 before a socket
 * exists. After that every frame either way is a JSON text frame with a
 * `type`; `common/gameSocket.ts` lists them. A socket subscribes to games it
 * can see, up to twenty at once, and is sent each game's changes as the
 * worker's `game_changes` listener hears of them.
 */
export function attachGameSocket(
  server: Server,
  db: Kysely<Database>,
  databaseUrl: string,
  options: GameSocketOptions = {}
): GameSocketHandle {
  const pingMs = options.pingMs ?? 30_000
  const recheckMs = options.recheckMs ?? 60_000
  const clock = options.clock ?? (() => Date.now())
  const log =
    options.log ??
    ((message: string) => {
      console.error(message)
    })
  const checkGame =
    options.checkGame ?? (async (_gameId, check) => await check())
  const connections = new Set<Connection>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES
  })
  const fanout = new GameFanout({
    ...options.fanout,
    db,
    databaseUrl,
    // Changes went unheard: every client reconnects and reads again.
    onLost: () => {
      for (const connection of connections)
        connection.ws.close(1012, 'Changes may have been missed')
    }
  })

  const scopesOf = async (connection: Connection): Promise<VisibleScopes> => {
    if (connection.scopes != null && clock() - connection.scopesAt < recheckMs)
      return connection.scopes
    connection.reading ??= visibleScopes(
      db,
      connection.actor.userId,
      connection.actor.isAdmin
    )
      .then(scopes => {
        connection.scopes = scopes
        connection.scopesAt = clock()
        return scopes
      })
      .finally(() => {
        connection.reading = undefined
      })
    return await connection.reading
  }

  const reply = (connection: Connection, frame: GameSocketReply): void => {
    if (connection.ws.readyState !== connection.ws.OPEN) return
    connection.ws.send(JSON.stringify(frame))
  }
  const refuse = (
    connection: Connection,
    code: GameSocketErrorCode,
    message: string,
    id?: string,
    gameId?: string
  ): void => {
    reply(connection, {
      type: 'error',
      ...(id == null ? {} : { id }),
      ...(gameId == null ? {} : { gameId }),
      code,
      message
    })
  }

  /**
   * Answers a request that threw (a database that is down or out of
   * connections) with `internal`, so every request is still answered once,
   * and says why on the server.
   */
  const failed = (
    connection: Connection,
    request: 'subscribe' | 'unsubscribe',
    gameId: string,
    id: string,
    error: unknown
  ): void => {
    log(`game socket: ${request} ${gameId}: ${String(error)}`)
    refuse(
      connection,
      'internal',
      `The server could not ${request}; try again`,
      id,
      gameId
    )
  }

  /** The game's scope, when this socket's person can see it. */
  const visibleGame = async (
    connection: Connection,
    gameId: string
  ): Promise<GameScope | undefined> => {
    const game = await db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id', 'season_id'])
      .where('id', '=', gameId)
      .executeTakeFirst()
    if (game == null) return undefined
    const scope: GameScope = {
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id,
      seasonId: game.season_id
    }
    // Read fresh: a subscribe is the one time the answer is shown.
    connection.scopes = undefined
    return canSeeGame(await scopesOf(connection), scope) ? scope : undefined
  }

  /**
   * Takes a subscribe's place under the cap as it arrives, before it waits
   * behind the game's earlier requests. Returns its claim, or undefined when
   * the socket already holds every place.
   */
  const claim = (
    connection: Connection,
    gameId: string
  ): number | undefined => {
    if (
      !connection.claims.has(gameId) &&
      connection.claims.size >= MAX_SUBSCRIPTIONS
    )
      return undefined
    const claimed = ++connection.sequence
    connection.claims.set(gameId, claimed)
    return claimed
  }

  const subscribe = async (
    connection: Connection,
    gameId: string,
    id: string,
    claimed: number | undefined
  ): Promise<void> => {
    if (claimed == null) {
      refuse(
        connection,
        'tooMany',
        `A socket may subscribe to at most ${MAX_SUBSCRIPTIONS} games`,
        id,
        gameId
      )
      return
    }
    if (connection.games.has(gameId)) {
      reply(connection, { type: 'subscribed', gameId, id })
      return
    }
    let scope: GameScope | undefined
    try {
      scope = await checkGame(
        gameId,
        async () => await visibleGame(connection, gameId)
      )
      if (scope != null && connections.has(connection)) {
        connection.games.add(gameId)
        fanout.watch(gameId, scope, connection.subscriber)
      }
    } catch (error: unknown) {
      // Nothing half done is kept: the game is not watched for this socket.
      scope = undefined
      connection.games.delete(gameId)
      throw error
    } finally {
      // A game it cannot see, or could not check, gives its place back,
      // unless a later request for the game has already taken or released it.
      if (scope == null && connection.claims.get(gameId) === claimed)
        connection.claims.delete(gameId)
    }
    if (scope == null) {
      refuse(connection, 'notFound', 'No such game', id, gameId)
      return
    }
    reply(connection, { type: 'subscribed', gameId, id })
  }

  const unsubscribe = (
    connection: Connection,
    gameId: string,
    id: string
  ): void => {
    connection.games.delete(gameId)
    fanout.unwatch(gameId, connection.subscriber)
    reply(connection, { type: 'unsubscribed', gameId, id })
  }

  /**
   * Runs `step` once the game's earlier requests on this socket are done.
   * One with nothing ahead of it runs at once, so a burst to different
   * games is handled side by side.
   */
  const inTurn = async (
    connection: Connection,
    gameId: string,
    step: () => Promise<void> | void
  ): Promise<void> => {
    const ahead = connection.turns.get(gameId)
    const run =
      ahead == null
        ? Promise.resolve(step())
        : ahead.then(async () => {
            await step()
          })
    const done = run.catch(() => undefined)
    connection.turns.set(gameId, done)
    try {
      await run
    } finally {
      if (connection.turns.get(gameId) === done) connection.turns.delete(gameId)
    }
  }

  const received = async (
    connection: Connection,
    data: RawData,
    isBinary: boolean
  ): Promise<void> => {
    let request: ReturnType<typeof asRequest>
    let id: string | undefined
    try {
      if (isBinary) throw new Error('binary')
      const raw: unknown = JSON.parse(rawText(data))
      const named = (raw as { id?: unknown } | null)?.id
      id = typeof named === 'string' ? named : undefined
      request = asRequest(raw)
    } catch {
      refuse(
        connection,
        'malformed',
        'Every frame is a JSON object with a type',
        id
      )
      return
    }
    if (request.type === 'ping') {
      reply(connection, { type: 'pong', id: request.id })
      return
    }
    const { gameId, type } = request
    const requestId = request.id
    // The cap is settled as each request arrives; its effect and its answer
    // wait their turn behind the game's earlier requests. One that throws is
    // still answered, and its turn still ends, so the next one runs.
    const answered = async (
      step: () => Promise<void> | void
    ): Promise<void> => {
      try {
        await step()
      } catch (error: unknown) {
        failed(connection, type, gameId, requestId, error)
      }
    }
    if (type === 'subscribe') {
      const claimed = claim(connection, gameId)
      await inTurn(connection, gameId, async () => {
        await answered(async () => {
          await subscribe(connection, gameId, requestId, claimed)
        })
      })
    } else {
      connection.claims.delete(gameId)
      await inTurn(connection, gameId, async () => {
        await answered(() => {
          unsubscribe(connection, gameId, requestId)
        })
      })
    }
  }

  const connected = (ws: WebSocket, actor: Actor): void => {
    const connection: Connection = {
      ws,
      actor,
      games: new Set(),
      claims: new Map(),
      sequence: 0,
      turns: new Map(),
      missed: 0,
      scopes: undefined,
      scopesAt: 0,
      reading: undefined,
      subscriber: {
        send: message => {
          reply(connection, message)
        },
        maySee: async game => {
          try {
            return canSeeGame(await scopesOf(connection), game)
          } catch {
            return false
          }
        }
      }
    }
    connections.add(connection)
    ws.on('pong', () => {
      connection.missed = 0
    })
    ws.on('message', (data, isBinary) => {
      received(connection, data, isBinary).catch((error: unknown) => {
        console.error(`game socket: ${String(error)}`)
      })
    })
    ws.on('error', () => undefined)
    ws.on('close', () => {
      connections.delete(connection)
      for (const gameId of connection.games)
        fanout.unwatch(gameId, connection.subscriber)
      connection.games.clear()
    })
  }

  const acceptUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): boolean => {
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://socket.invalid').pathname
    } catch {
      return false
    }
    if (path !== SOCKET_PATH) return false
    socket.on('error', () => undefined)
    const token = sessionToken(req.headers.authorization, req.headers.cookie)
    if (token == null) {
      refuseUpgrade(socket, 401, 'Unauthorized')
      return true
    }
    actorForToken(db, token).then(
      actor => {
        if (actor == null) {
          refuseUpgrade(socket, 401, 'Unauthorized')
          return
        }
        wss.handleUpgrade(req, socket, head, ws => {
          connected(ws, actor)
        })
      },
      (error: unknown) => {
        console.error(`game socket: signing in an upgrade: ${String(error)}`)
        refuseUpgrade(socket, 500, 'Internal Server Error')
      }
    )
    return true
  }
  const upgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void => {
    if (!acceptUpgrade(req, socket, head)) {
      refuseUpgrade(socket, 404, 'Not Found')
    }
  }
  if (options.listenForUpgrades !== false) server.on('upgrade', upgrade)

  // Two missed pings and the socket is gone: a phone that walked out of Wi-Fi
  // range never says goodbye, and its subscriptions would be read for ever.
  const pinger = setInterval(() => {
    for (const connection of connections) {
      if (connection.missed >= 2) {
        connection.ws.terminate()
        continue
      }
      connection.missed++
      connection.ws.ping()
    }
  }, pingMs)
  pinger.unref()

  const stopSignals =
    options.stopSignals === undefined ? process : options.stopSignals
  const stop = (): void => {
    close().catch(() => undefined)
  }
  let closing: Promise<void> | undefined
  const close = async (): Promise<void> => {
    closing ??= (async () => {
      clearInterval(pinger)
      server.off('upgrade', upgrade)
      stopSignals?.off('SIGTERM', stop)
      stopSignals?.off('SIGINT', stop)
      for (const connection of connections)
        connection.ws.close(1001, 'The server is restarting')
      await fanout.close()
      await new Promise<void>(resolve => {
        wss.close(() => {
          resolve()
        })
      })
    })()
    await closing
  }
  stopSignals?.on('SIGTERM', stop)
  stopSignals?.on('SIGINT', stop)

  return {
    fanout,
    size: () => connections.size,
    acceptUpgrade,
    close
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  )
}
