import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { asEither, asObject, asOptional, asString } from 'cleaners'
import type { Kysely } from 'kysely'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'

import { asLiteral } from '../../common/asLiteral'
import {
  type GameSocketErrorCode,
  type GameSocketReply,
  type ScreenScopeName,
  TYPING_INTERVAL_MS
} from '../../common/gameSocket'
import {
  canSeeGame,
  type GameScope,
  type VisibleScopes,
  visibleScopes,
  visibleScopesForUsers
} from '../access'
import {
  type Actor,
  actorForToken,
  actorsForTokens,
  keyAllows
} from '../auth/sessions'
import { sessionToken } from '../auth/tokens'
import type { ChangeFeed } from '../changeFeed/feed'
import { PostgresFeed } from '../changeFeed/postgresFeed'
import { mayPost, type PostingStanding } from '../chat/messages'
import { type Database, isPoolTimeout } from '../db/database'
import {
  ChatFanout,
  type ChatFanoutOptions,
  type ChatSubscriber,
  notifyTyping
} from './chatFanout'
import {
  type FanoutSubscriber,
  GameFanout,
  type GameFanoutOptions
} from './fanout'
import {
  ScreenScopeListener,
  type ScreenScopeListenerOptions
} from './screenScope'
import { RESYNC_SPREAD_MS, spread } from './spread'
import { readSyncClock, type ScreenScopePayload } from './syncRevision'

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
  /**
   * The process's feed, which stays open when the socket closes. Without it
   * the socket builds and owns a `PostgresFeed` on its `databaseUrl`.
   */
  feed?: ChangeFeed
  /**
   * The window a resync's 1012 closes and `resync` frames are spread over, so
   * thousands of clients do not read again at the same instant.
   * `RESYNC_SPREAD_MS` unless given; 0 acts at once.
   */
  resyncSpreadMs?: number
  fanout?: Omit<GameFanoutOptions, 'db' | 'feed' | 'authorize' | 'onResync'>
  screenScopes?: Omit<
    ScreenScopeListenerOptions,
    'feed' | 'deliver' | 'onResync'
  >
  chat?: Omit<ChatFanoutOptions, 'db' | 'feed' | 'resyncSpreadMs'>
  /**
   * Wraps each typing hint's check, which `check` runs. For tests, to make
   * it fail; the check itself unless given.
   */
  checkTyping?: (
    conversationId: string,
    check: () => Promise<PostingStanding>
  ) => Promise<PostingStanding>
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
  feed: ChangeFeed
  fanout: GameFanout
  screenScopes: ScreenScopeListener
  chat: ChatFanout
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
    type: asLiteral('subscribe', 'unsubscribe'),
    gameId: asString,
    id: asString
  }),
  asObject({ type: asLiteral('ping'), id: asString }),
  asObject({
    type: asLiteral('typing'),
    conversationId: asString,
    id: asString
  })
)

/**
 * A screen scope's frame. It is read only from an object with a `scope`,
 * and the game frame only from one without, so a scope never takes a place
 * under `MAX_SUBSCRIPTIONS`.
 */
const asScopeRequest = asEither(
  asObject({
    type: asLiteral('subscribe'),
    scope: asLiteral('home', 'schedule'),
    id: asString
  }),
  asObject({
    type: asLiteral('subscribe'),
    scope: asLiteral('event'),
    gameId: asString,
    id: asString
  }),
  asObject({
    type: asLiteral('unsubscribe'),
    scope: asLiteral('home', 'schedule', 'event'),
    gameId: asOptional(asString),
    id: asString
  })
)
type ScopeRequest = ReturnType<typeof asScopeRequest>

/** The screen scope a socket holds. */
interface HeldScreen {
  scope: ScreenScopeName
  /** For an event. */
  gameId?: string
}

/** One open socket: who it is, what it has subscribed to, and its health. */
interface Connection {
  token: string
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
  subscriber: FanoutSubscriber
  /** The visible screen's scope, once registered. */
  screen: HeldScreen | undefined
  /** A spread 1012 close is still to come. */
  closeDue: boolean
  /** A spread `resync` frame for the screen is still to come. */
  screenResyncDue: boolean
  /** The last scope request still being handled; the next waits on it. */
  screenTurn: Promise<void>
  /** Set for a signed-in session: what hears its person's chat hints. */
  chat: ChatSubscriber | undefined
  /** When this socket last sent a typing hint that was looked at. */
  typedAt: number
}

/** Each frame's bytes, for as long as somebody still holds the frame. */
const encodedFrames = new WeakMap<GameSocketReply, Buffer>()

/**
 * A frame as it goes out, made once however many sockets hear it. One delivery
 * carries a game's whole list of plays to everybody watching it, and encoding
 * that again for each of them holds the worker up for seconds.
 */
function encodedFrame(frame: GameSocketReply): Buffer {
  let encoded = encodedFrames.get(frame)
  if (encoded == null) {
    encoded = Buffer.from(JSON.stringify(frame))
    encodedFrames.set(frame, encoded)
  }
  return encoded
}

/**
 * Which of these subscribers may see the game, on the delivery's connection: a
 * read of their credentials and a set of reads of their scopes, however many
 * there are. Somebody whose credential no longer answers as them is signed out
 * and sent nothing. Nobody is sent anything when the reads fail.
 */
export async function authorizeSubscribers(
  subscribers: FanoutSubscriber[],
  game: GameScope,
  source: Kysely<Database>,
  log: (message: string) => void
): Promise<boolean[]> {
  if (subscribers.length === 0) return []
  try {
    const actors = await actorsForTokens(
      source,
      subscribers.map(subscriber => subscriber.token)
    )
    const stillThem = (subscriber: FanoutSubscriber): boolean =>
      actors.get(subscriber.token)?.userId === subscriber.userId
    const scopes = await visibleScopesForUsers(
      source,
      subscribers.filter(stillThem).map(subscriber => subscriber.userId)
    )
    return subscribers.map(subscriber => {
      if (stillThem(subscriber))
        return canSeeGame(scopes.get(subscriber.userId)!, game)
      subscriber.signedOut()
      return false
    })
  } catch (error: unknown) {
    log(`game socket: authorizing a delivery: ${String(error)}`)
    return subscribers.map(() => false)
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
 *
 * A socket signed in with a session (not a machine token, which cannot use
 * chat) is also registered in the worker's `ChatFanout`, and so hears its
 * person's chat hints with nothing to subscribe to. It may send `typing` for
 * a conversation its person may post in, at most once every three seconds.
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
  const checkTyping =
    options.checkTyping ?? (async (_conversationId, check) => await check())
  const resyncSpreadMs = options.resyncSpreadMs ?? RESYNC_SPREAD_MS
  /** A resync's closes and frames still to come. */
  const spreadTimers = new Set<ReturnType<typeof setTimeout>>()
  const connections = new Set<Connection>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES
  })
  const feed =
    options.feed ??
    new PostgresFeed({
      databaseUrl,
      log: message => {
        log(`change feed: ${message}`)
      }
    })
  // Changes went unheard: each client watching a game reconnects and reads
  // again, at its own moment. One already due goes once. A socket that stopped
  // watching meanwhile, or left, has nothing to read again.
  const closeToResync = (targets: Connection[]): void => {
    const due = targets.filter(connection => !connection.closeDue)
    for (const connection of due) connection.closeDue = true
    spread(
      due,
      resyncSpreadMs,
      connection => {
        connection.closeDue = false
        if (connection.games.size > 0)
          connection.ws.close(1012, 'Changes may have been missed')
      },
      spreadTimers
    )
  }
  // Notices went unheard or unsent: each screen subscribes again and reads, at
  // its own moment. A frame still to come covers whatever is missed before it.
  const resyncScreens = (targets: Connection[]): void => {
    const due = targets.filter(
      connection => connection.screen != null && !connection.screenResyncDue
    )
    for (const connection of due) connection.screenResyncDue = true
    spread(
      due,
      resyncSpreadMs,
      connection => {
        connection.screenResyncDue = false
        if (connection.screen != null) reply(connection, { type: 'resync' })
      },
      spreadTimers
    )
  }
  const fanout = new GameFanout({
    ...options.fanout,
    db,
    feed,
    authorize: async (subscribers, game, source) =>
      await authorizeSubscribers(subscribers, game, source, log),
    // A socket watching no game has its screen's and chat's own resync.
    onResync: () => {
      closeToResync(
        [...connections].filter(connection => connection.games.size > 0)
      )
    }
  })
  const screenScopes = new ScreenScopeListener({
    ...options.screenScopes,
    feed,
    deliver: async payload => {
      await announce(payload)
    },
    onResync: () => {
      resyncScreens([...connections])
    }
  })
  const chat = new ChatFanout({ ...options.chat, db, feed, resyncSpreadMs })

  /** Whether this socket's copy of its person's scopes is still good. */
  const scopesFresh = (connection: Connection): boolean =>
    connection.scopes != null && clock() - connection.scopesAt < recheckMs

  /** A read under way for a socket, whose result becomes its copy. */
  const readingInto = async (
    connection: Connection,
    read: Promise<VisibleScopes>
  ): Promise<VisibleScopes> =>
    await read
      .then(scopes => {
        connection.scopes = scopes
        connection.scopesAt = clock()
        return scopes
      })
      .finally(() => {
        connection.reading = undefined
      })

  const scopesOf = async (connection: Connection): Promise<VisibleScopes> => {
    if (scopesFresh(connection)) return connection.scopes!
    connection.reading ??= readingInto(
      connection,
      visibleScopes(db, connection.actor.userId, connection.actor.isAdmin)
    )
    return await connection.reading
  }

  /**
   * Reads the scopes of every one of these sockets whose copy is stale, once
   * for all their people, so that `scopesOf` then finds each read under way.
   */
  const readScopesOf = (concerned: Connection[]): void => {
    const stale = concerned.filter(
      connection => !scopesFresh(connection) && connection.reading == null
    )
    if (stale.length === 0) return
    const reading = visibleScopesForUsers(
      db,
      stale.map(connection => connection.actor.userId)
    )
    for (const connection of stale)
      connection.reading = readingInto(
        connection,
        reading.then(scopes => scopes.get(connection.actor.userId)!)
      )
  }

  const reply = (connection: Connection, frame: GameSocketReply): void => {
    if (connection.ws.readyState !== connection.ws.OPEN) return
    connection.ws.send(encodedFrame(frame), { binary: false })
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
    const authenticated = await actorForToken(db, connection.token)
    if (authenticated?.userId !== connection.actor.userId) {
      connection.ws.close(1008, 'Sign in again')
      return undefined
    }
    connection.actor = authenticated
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
    connection.reading = undefined
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
   * Registers the visible screen's scope, in place of any other, and answers
   * with the revision it was registered at. Every notice committed after
   * this reaches the socket, so a read the screen starts on the answer
   * misses nothing. An event the person cannot see is refused and not held.
   */
  const subscribeScreen = async (
    connection: Connection,
    request: ScopeRequest & { type: 'subscribe' }
  ): Promise<void> => {
    connection.screen = undefined
    let screen: HeldScreen = { scope: request.scope }
    if (request.scope === 'event') {
      const { gameId } = request
      const game = await checkGame(
        gameId,
        async () => await visibleGame(connection, gameId)
      )
      if (game == null) {
        refuse(connection, 'notFound', 'No such game', request.id)
        return
      }
      screen = { scope: 'event', gameId }
    }
    if (!connections.has(connection)) return
    connection.screen = screen
    const revision = await readSyncClock(db)
    if (connection.screen !== screen) return
    reply(connection, {
      type: 'subscribed',
      scope: screen.scope,
      id: request.id,
      revision
    })
  }

  /** Lets the named scope go, if it is still the one held. */
  const unsubscribeScreen = (
    connection: Connection,
    request: ScopeRequest & { type: 'unsubscribe' }
  ): void => {
    const held = connection.screen
    if (
      held?.scope === request.scope &&
      (request.gameId == null || held.gameId === request.gameId)
    )
      connection.screen = undefined
    reply(connection, {
      type: 'unsubscribed',
      scope: request.scope,
      id: request.id
    })
  }

  /** Scope requests take effect, and are answered, in the order sent. */
  const screenRequest = async (
    connection: Connection,
    request: ScopeRequest
  ): Promise<void> => {
    const run = connection.screenTurn.then(async () => {
      try {
        if (request.type === 'subscribe')
          await subscribeScreen(connection, request)
        else unsubscribeScreen(connection, request)
      } catch (error: unknown) {
        connection.screen = undefined
        log(`game socket: ${request.type} ${request.scope}: ${String(error)}`)
        refuse(
          connection,
          'internal',
          `The server could not ${request.type}; try again`,
          request.id
        )
      }
    })
    connection.screenTurn = run
    await run
  }

  /**
   * Tells each socket whose screen a committed write concerns. A game goes
   * to its event's sockets, and to home and schedule, wherever the person
   * can see the game. A team or season goes to home and schedule where the
   * person sees it, and a person's own change to their home and schedule.
   * Nothing else is told: a notice nobody matches is dropped.
   */
  const announce = async (payload: ScreenScopePayload): Promise<void> => {
    const holding = [...connections].filter(
      connection => connection.screen != null
    )
    if (holding.length === 0) return
    const { gameId, teamId, seasonId, userId, revision } = payload
    // A notice of one game alone (a play, its score) names it to home and
    // schedule too, so a list that shows no games can let it pass.
    const gameOnly =
      gameId != null && teamId == null && seasonId == null && userId == null
    const tell = (connection: Connection, screen: HeldScreen): void => {
      if (connection.screen !== screen) return
      reply(connection, {
        type: 'changed',
        scope: screen.scope,
        revision,
        ...(screen.scope === 'event' || gameOnly ? { gameId } : {})
      })
    }
    const row =
      gameId == null
        ? undefined
        : await db
            .selectFrom('games')
            .select(['home_team_id', 'away_team_id', 'season_id'])
            .where('id', '=', gameId)
            .executeTakeFirst()
    const game: GameScope | undefined =
      row == null
        ? undefined
        : {
            homeTeamId: row.home_team_id,
            awayTeamId: row.away_team_id,
            seasonId: row.season_id
          }
    // Everybody whose answer turns on their scopes, read together.
    readScopesOf(
      holding.filter(connection => {
        const screen = connection.screen!
        if (gameId != null)
          return (
            game != null &&
            (screen.scope !== 'event' || screen.gameId === gameId)
          )
        if (screen.scope === 'event') return false
        if (userId != null && connection.actor.userId === userId) return false
        return teamId != null || seasonId != null
      })
    )
    const unread: Connection[] = []
    await Promise.all(
      holding.map(async connection => {
        const screen = connection.screen!
        try {
          if (gameId != null) {
            if (screen.scope === 'event' && screen.gameId !== gameId) return
            // A game gone since: only the sockets that had it open are told.
            if (game == null) {
              if (screen.scope === 'event') tell(connection, screen)
              return
            }
            if (canSeeGame(await scopesOf(connection), game))
              tell(connection, screen)
            return
          }
          if (screen.scope === 'event') return
          if (userId != null && connection.actor.userId === userId) {
            // What they belong to moved: read it afresh next time.
            connection.scopes = undefined
            tell(connection, screen)
            return
          }
          if (teamId == null && seasonId == null) return
          const scopes = await scopesOf(connection)
          if (
            scopes.isAdmin ||
            (teamId != null && scopes.teamIds.has(teamId)) ||
            (seasonId != null && scopes.seasonIds.has(seasonId))
          )
            tell(connection, screen)
        } catch (error: unknown) {
          if (isPoolTimeout(error)) unread.push(connection)
          else log(`game socket: telling ${screen.scope}: ${String(error)}`)
        }
      })
    )
    if (unread.length === 0) return
    log(
      `game socket: resyncing ${unread.length} screen(s): no database connection in time`
    )
    resyncScreens(unread)
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
    let request: ReturnType<typeof asRequest> | ScopeRequest
    let id: string | undefined
    try {
      if (isBinary) throw new Error('binary')
      const raw: unknown = JSON.parse(rawText(data))
      const named = (raw as { id?: unknown } | null)?.id
      id = typeof named === 'string' ? named : undefined
      request =
        typeof raw === 'object' && raw != null && 'scope' in raw
          ? asScopeRequest(raw)
          : asRequest(raw)
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
    if ('scope' in request) {
      await screenRequest(connection, request)
      return
    }
    if (request.type === 'typing') {
      await typed(connection, request.conversationId, request.id)
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

  /**
   * A typing hint: at most one every `TYPING_INTERVAL_MS` per socket is
   * looked at, and it is passed on, unstored, only from a member who may
   * post there. Anything else is refused, and nothing is sent.
   */
  const typed = async (
    connection: Connection,
    conversationId: string,
    id: string
  ): Promise<void> => {
    const refuseTyping = (code: GameSocketErrorCode, message: string): void => {
      reply(connection, { type: 'error', id, conversationId, code, message })
    }
    if (connection.chat == null) {
      refuseTyping('forbidden', 'Chat needs a signed-in session')
      return
    }
    const now = clock()
    if (now - connection.typedAt < TYPING_INTERVAL_MS) {
      refuseTyping('tooMany', 'At most one typing hint every three seconds')
      return
    }
    connection.typedAt = now
    const userId = connection.actor.userId
    let standing: PostingStanding
    try {
      standing = await checkTyping(
        conversationId,
        async () => await mayPost(db, conversationId, userId, new Date(now))
      )
      if (standing === 'poster')
        await notifyTyping(feed, db, conversationId, userId)
    } catch (error: unknown) {
      log(`chat socket: typing in ${conversationId}: ${String(error)}`)
      refuseTyping('internal', 'The server could not pass that on; try again')
      return
    }
    if (standing === 'reader') {
      refuseTyping('forbidden', 'Only those who may post here may type')
      return
    }
    if (standing === 'stranger') {
      refuseTyping('notFound', 'No such conversation')
      return
    }
    reply(connection, { type: 'typed', conversationId, id })
  }

  const connected = (ws: WebSocket, actor: Actor, token: string): void => {
    const connection: Connection = {
      token,
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
      screen: undefined,
      screenTurn: Promise.resolve(),
      closeDue: false,
      screenResyncDue: false,
      subscriber: {
        send: message => {
          reply(connection, message)
        },
        token,
        userId: actor.userId,
        signedOut: () => {
          connection.ws.close(1008, 'Sign in again')
        },
        resync: () => {
          closeToResync([connection])
        }
      },
      chat: undefined,
      typedAt: Number.NEGATIVE_INFINITY
    }
    if (actor.sessionId != null) {
      connection.chat = {
        userId: actor.userId,
        send: frame => {
          reply(connection, frame)
        }
      }
      chat.add(connection.chat)
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
      connection.screen = undefined
      if (connection.chat != null) chat.remove(connection.chat)
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
        // A key subscribes to games only with game events read.
        if (!keyAllows(actor, 'gameEvents:read')) {
          refuseUpgrade(socket, 403, 'Forbidden')
          return
        }
        wss.handleUpgrade(req, socket, head, ws => {
          connected(ws, actor, token)
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
      for (const timer of spreadTimers) clearTimeout(timer)
      spreadTimers.clear()
      for (const connection of connections)
        connection.ws.close(1001, 'The server is restarting')
      await fanout.close()
      await screenScopes.close()
      await chat.close()
      if (options.feed == null) await feed.close()
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
    feed,
    fanout,
    screenScopes,
    chat,
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
