import {
  asArray,
  asBoolean,
  asEither,
  asMaybe,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import type { TeamLineups } from './api'
import { asLiteral } from './asLiteral'
import { asUserId } from './userId'
import type { WalkUpSong } from './walkUpSong'
import { socketForActor } from './webPasswordLink'

/**
 * A game's changes, as they happen, over one WebSocket at `/socket`.
 *
 * The server end is `server/socket/gameSocket.ts`. A screen subscribes to a
 * game and is sent a `change` whenever that game's plays, lineups, score or a
 * player's walk-up song change. Nothing here is the record: a message is a
 * nudge with the new data attached, and after a reconnect the screen is sent
 * `resync` and reads the game again over REST, because whatever changed while
 * the socket was down was never sent.
 *
 * The same socket carries chat. A signed-in socket hears, without
 * subscribing, a `chat` hint for each conversation its person is in whenever
 * something in it changes, a `chatUser` hint when their own devices or links
 * do, and `chatTyping` when another member types. Nothing of a message
 * travels here: the hint says only what changed, and the app fetches it. A
 * `resync` means hints may have been missed: read every conversation again.
 */

/**
 * The version of the game socket's frames this app speaks, sent with every
 * game and screen scope subscribe. A server refuses a subscribe below its
 * minimum as `forbidden` with the reason `updateRequired`, so an app too old
 * to read what it would be sent stops following instead of misreading it. 3
 * is the first whose scope frames carry no revision. 4 is the first that
 * reads an end of the half that keeps the at-bat in progress (`keepAtBat`):
 * an older app drops that at-bat on replay, and every later play moves down
 * an index. 5 reads explicit pitcher resets and selected batting slots.
 * 6 holds user topics (the bell, the phone's offline games, Tess's answer),
 * the team and group screen scopes, and a game's `roster` and
 * `defaultLineup` changes.
 * It is the socket's and the API's version only: how the engine
 * folds a log, which a phone's queued saves are judged by, is
 * `FOLD_VERSION`, and moves only when that does.
 */
export const GAME_SOCKET_PROTOCOL = 6

/**
 * The oldest protocol a game or scope subscribe may name on any server: an
 * app below it misreads a scope's frames. Rendered score views need no more;
 * replay source with newer actions is gated separately at its HTTP resource.
 */
export const MINIMUM_GAME_SOCKET_PROTOCOL = 3

/**
 * The oldest protocol a save of a game's plays may name on any server: an app
 * below it cannot replay explicit pitcher resets or selected batting slots.
 */
export const MINIMUM_SAVE_PROTOCOL = 5

/** Replay clients fold stored actions; rendered score-only views do not. */
export const MINIMUM_OVERRIDE_REPLAY_PROTOCOL = 5

/**
 * The minimum a server holds subscribes to: its config's, never below
 * `MINIMUM_GAME_SOCKET_PROTOCOL`. A config can raise it and never lower it,
 * since every server writes the minimum it started with back into its config
 * file, which pins it there.
 */
export function minimumProtocolOf(configured: number | undefined): number {
  return Math.max(MINIMUM_GAME_SOCKET_PROTOCOL, configured ?? 0)
}

/** The minimum a save of plays is held to: the subscribes', and 5 at least. */
export function saveProtocolOf(configured: number | undefined): number {
  return Math.max(MINIMUM_SAVE_PROTOCOL, minimumProtocolOf(configured))
}

/**
 * The header the app names `GAME_SOCKET_PROTOCOL` in on every API request.
 * A save of a game's plays from an app older than the server's minimum is
 * refused as the socket refuses its subscribe (`updateRequired`).
 */
export const PROTOCOL_HEADER = 'x-teamstation-protocol'

/**
 * A stored play as `GET /games/:gameId/events` gives each row: its id, its
 * game and its document, named.
 */
export interface WirePlayRow {
  id: string
  gameId: string
  gumbo: unknown
}

/**
 * One change to a game's stored plays: a play written at its
 * `gumbo.about.atBatIndex`, in place of whatever was there, or the play at
 * an index taken away. A put of a play the holder already has changes
 * nothing.
 */
export type PlayEdit =
  { op: 'put'; play: WirePlayRow } | { op: 'remove'; atBatIndex: number }

/** What a `change` is about. */
export type GameChangeKind =
  | 'playEdits'
  | 'lineups'
  | 'walkUpSong'
  | 'game'
  | 'plans'
  | 'roster'
  | 'defaultLineup'

/**
 * How a game's stored plays changed, as a `playEdits` change carries it: the
 * edits that take a holder of the game at `fromDigest` to `digest`
 * (`applyPlayEdits`), or, with `edits` null, only that the plays changed, so
 * a holder reads the game again: unless it holds `digest`, which a post's
 * re-read form still names, as the post's own sender does.
 */
export interface PlayEditsData {
  /** The game's play generation the edits were made in. */
  generation: number
  /** The `playsDigest` the edits apply to; null when `edits` is. */
  fromDigest: string | null
  /**
   * The `playsDigest` once they are applied, or the write left; null when
   * none was worked out.
   */
  digest: string | null
  /**
   * The digest of the book the edits' plays are named from, as `GET
   * /games/:gameId/events` answers it for its public naming (`namesDigest`):
   * edits apply only to a read made from the same book, since a player's
   * public name can change with nothing written. Null when none was worked
   * out, as on another writer's change.
   */
  namesDigest: string | null
  /** Null: read the game again. */
  edits: PlayEdit[] | null
  /** The at-bat in progress, named, when `edits` is not null. */
  currentPlay?: unknown
}

/** The `data` of each kind of change. */
export interface GameChangeData {
  /**
   * What changed in the stored plays and the at-bat in progress, with the
   * `playsDigest` it leaves: a screen tells its own save's echo from another
   * device's plays by it.
   */
  playEdits: PlayEditsData
  /**
   * Both sides' lineups and their digest, as `GET /games/:gameId/lineups`
   * answers: a screen tells its own save's echo from another device's
   * change by the digest.
   */
  lineups: { home: TeamLineups; away: TeamLineups; digest: string }
  /** One player's song on one team, or null once it is removed. */
  walkUpSong: { teamId: string; userId: string; song: WalkUpSong | null }
  /**
   * A team's game plan was saved with a change to the inning in play. Only
   * the team and the inning are named, as every viewer of the game hears it:
   * the scoring screen reads that inning's column again, and the team's
   * coaches read `GET /games/:gameId/plans` again.
   */
  plans: { teamId: string; inning: number }
  /** One side's roster changed: read it again. */
  roster: { teamId: string }
  /** One side's default lineup changed: read it again. */
  defaultLineup: { teamId: string }
  game: {
    status: 'scheduled' | 'inProgress' | 'final' | 'cancelled'
    awayScore: number | null
    homeScore: number | null
    /**
     * The teams as the game now stands: a screen opened on others reopens.
     * An older server sends none.
     */
    homeTeamId?: string
    awayTeamId?: string
    /**
     * The game's play generation: a screen opened on another reopens, for
     * the plays it holds were reset. An older server sends none.
     */
    generation?: number
    /**
     * Whether a team withdrew from the game, which is then never changed.
     * An older server sends none.
     */
    withdrawn?: boolean
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
  | 'notFound'
  | 'malformed'
  | 'tooMany'
  | 'internal'
  /**
   * A member who may not post (an Announcements reader) typed, or a game or
   * scope subscribe whose protocol is older than the server reads (with the
   * reason `updateRequired`).
   */
  | 'forbidden'

/**
 * Why a refusal was made, beyond its code: `updateRequired`, a game or scope
 * subscribe whose protocol is older than the server reads. It rides on a
 * `forbidden` error, which apps older than the protocol already read.
 */
export type GameSocketErrorReason = 'updateRequired'

/** What a subscriber hears. */
export type GameSocketEvent =
  | GameChange
  /** Messages may have been missed: read the game again. */
  | { type: 'resync'; gameId: string }
  /** The server confirmed it hears this game now. */
  | { type: 'subscribed'; gameId: string }
  /**
   * The server will not send this game to an app this old: it is never
   * asked for again. Heard instead of the `error`.
   */
  | { type: 'updateRequired'; gameId: string }
  | {
      type: 'error'
      gameId: string
      code: GameSocketErrorCode
      message: string
    }

export type GameSocketListener = (event: GameSocketEvent) => void

/**
 * The screens that hold a scope on the socket. A socket holds at most one,
 * the visible screen's, and a subscribe to another replaces it.
 */
export type ScreenScopeName = 'home' | 'schedule' | 'event' | 'team' | 'group'

/** A season, league or node a group screen shows. */
export type GroupScopeKind = 'season' | 'league' | 'node'

/** One screen's scope: Home, Schedule, one event, one team or one group. */
export type ScreenScope =
  | { scope: 'home' }
  | { scope: 'schedule' }
  | { scope: 'event'; gameId: string }
  | { scope: 'team'; teamId: string }
  | { scope: 'group'; kind: GroupScopeKind; id: string }

/**
 * What the signed-in person hears whatever screen is open: the bell, the
 * games a phone keeps to score with no signal, and Tess's answer.
 */
export type UserTopic = 'badge' | 'offlineSet' | 'tess'

export const USER_TOPICS: readonly UserTopic[] = ['badge', 'offlineSet', 'tess']

/**
 * What a user topic's listener hears. Nothing carries a record: `changed`
 * says to read the topic's resource once over REST.
 */
export type UserTopicEvent =
  /**
   * The server holds the topic for this socket. `afterGap`: the socket had
   * been lost, so notices may have been missed; read once.
   */
  | { type: 'subscribed'; afterGap: boolean }
  /** Something the topic covers changed, or its time came. */
  | { type: 'changed' }
  /** Notices may have been missed: read once. */
  | { type: 'resync' }
  /**
   * The socket is down and waiting to try again. `outage` stays the same
   * through every retry of one outage, so a reader reads once per outage.
   */
  | { type: 'unreachable'; outage: number }
  /** The server holds no topics (an older one): read once per connection. */
  | { type: 'unsupported' }

export type UserTopicListener = (event: UserTopicEvent) => void

/**
 * What the screen holding a scope hears. No frame carries a record: a
 * `changed` says something the scope shows changed, and the screen reads it
 * over REST.
 */
export type ScreenScopeEvent =
  /** The server registered this socket: the screen may read. */
  | { type: 'subscribed' }
  /**
   * On home or schedule, `gameId` says the notice was of that one game
   * alone (a play, its score): a list that shows no games can let it pass.
   * On an event it names the event's game. `byPost` says a post of plays
   * made the change, whose play frames already read the game's own screen.
   */
  | { type: 'changed'; gameId?: string; byPost?: boolean }
  /** The scope was refused (`notFound` for an event it cannot see). */
  | { type: 'error'; code: GameSocketErrorCode; message: string }
  /** The acknowledgement no longer holds. It is asked for again. */
  | { type: 'resync' }
  /** Nothing will be acknowledged until the session token changes. */
  | { type: 'stopped' }
  /**
   * The socket is down after a connection was lost or refused, and is
   * waiting to try again: no acknowledgement is coming soon, so the screen
   * reads at once, and the next `subscribed` reads again. `outage` stays
   * the same through every retry of one outage.
   */
  | { type: 'unreachable'; outage?: number }

export type ScreenScopeListener = (event: ScreenScopeEvent) => void

/** What changed in a conversation: as `chat_changes` names it. */
export type ChatHintKind = 'message' | 'members' | 'epoch' | 'grant' | 'read'

/** What changed about the person's own chat keys. */
export type ChatUserHintKind = 'link' | 'devices' | 'preferences' | 'blocks'

/** A chat frame the server sends. */
export type ChatSocketFrame =
  | {
      type: 'chat'
      conversationId: string
      kind: ChatHintKind
      /** A new message's, or a moved read cursor's. */
      seq?: number
      /** When the server sent it. */
      at: string
    }
  | { type: 'chatUser'; kind: ChatUserHintKind }
  | { type: 'chatTyping'; conversationId: string; userId: string }
  /** Hints may have been missed: read every conversation again. */
  | { type: 'resync' }

/** What a chat listener hears. */
export type ChatSocketEvent =
  | ChatSocketFrame
  /** The server refused a typing hint. */
  | {
      type: 'error'
      conversationId: string
      code: GameSocketErrorCode
      message: string
    }

export type ChatSocketListener = (event: ChatSocketEvent) => void

/** A socket sends at most one typing hint this often. */
export const TYPING_INTERVAL_MS = 3000

/** A frame the client sends. */
export type GameSocketRequest =
  /** `protocol` is `GAME_SOCKET_PROTOCOL`. */
  | { type: 'subscribe'; gameId: string; id: string; protocol: number }
  | { type: 'unsubscribe'; gameId: string; id: string }
  /** A subscribe's `protocol` is `GAME_SOCKET_PROTOCOL`. */
  | {
      type: 'subscribe' | 'unsubscribe'
      scope: 'home' | 'schedule'
      id: string
      protocol?: number
    }
  | {
      type: 'subscribe' | 'unsubscribe'
      scope: 'event'
      gameId: string
      id: string
      protocol?: number
    }
  | {
      type: 'subscribe' | 'unsubscribe'
      scope: 'team'
      teamId: string
      id: string
      protocol?: number
    }
  | {
      type: 'subscribe' | 'unsubscribe'
      scope: 'group'
      kind: GroupScopeKind
      groupId: string
      id: string
      protocol?: number
    }
  /** A user topic of the signed-in person; needs protocol 6. */
  | {
      type: 'subscribe' | 'unsubscribe'
      topic: UserTopic
      id: string
      protocol?: number
    }
  | { type: 'ping'; id: string }
  /** The person is typing in a conversation they may post in. */
  | { type: 'typing'; conversationId: string; id: string }

/** A screen scope's frames from the server. */
export type ScreenScopeReply =
  | { type: 'subscribed'; scope: ScreenScopeName; id: string }
  | { type: 'unsubscribed'; scope: ScreenScopeName; id: string }
  | {
      type: 'changed'
      scope: ScreenScopeName
      gameId?: string
      /** A team scope's team. */
      teamId?: string
      /** A group scope's group. */
      groupId?: string
      byPost?: boolean
    }
  /** The worker lost its `LISTEN`: subscribe the scope again and read. */
  | { type: 'resync' }

/** A user topic's frames from the server. */
export type UserTopicReply =
  | { type: 'subscribed'; topic: UserTopic; id: string }
  | { type: 'unsubscribed'; topic: UserTopic; id: string }
  | { type: 'userChanged'; topic: UserTopic }
  /** The worker lost its `LISTEN`: read each of these topics once. */
  | { type: 'userResync'; topics: UserTopic[] }

/** A frame the server sends. */
export type GameSocketReply =
  | GameChange
  | ChatSocketFrame
  | { type: 'subscribed'; gameId: string; id: string }
  | { type: 'unsubscribed'; gameId: string; id: string }
  | ScreenScopeReply
  | UserTopicReply
  | { type: 'pong'; id: string }
  /** A typing hint was passed on. */
  | { type: 'typed'; conversationId: string; id: string }
  | {
      type: 'error'
      id?: string
      gameId?: string
      conversationId?: string
      code: GameSocketErrorCode
      reason?: GameSocketErrorReason
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
  conversationId: asOptional(asString),
  code: asLiteral(
    'notFound',
    'malformed',
    'tooMany',
    'internal',
    'forbidden'
  ) as Cleaner<GameSocketErrorCode>,
  // A reason this app does not know is left out: the code stands alone.
  reason: asOptional(asMaybe(asLiteral('updateRequired'))),
  message: asString
})

const asChatFrame: Cleaner<ChatSocketFrame> = asEither(
  asObject({
    type: asLiteral('chat'),
    conversationId: asString,
    kind: asLiteral(
      'message',
      'members',
      'epoch',
      'grant',
      'read'
    ) as Cleaner<ChatHintKind>,
    seq: asOptional(asNumber),
    at: asString
  }),
  asObject({
    type: asLiteral('chatUser'),
    kind: asLiteral(
      'link',
      'devices',
      'preferences',
      'blocks'
    ) as Cleaner<ChatUserHintKind>
  }),
  asObject({
    type: asLiteral('chatTyping'),
    conversationId: asString,
    userId: asUserId
  }),
  asObject({ type: asLiteral('resync') })
)

/** The chat frames' types, which the chat listeners hear. */
const CHAT_FRAMES = new Set(['chat', 'chatUser', 'chatTyping', 'resync'])

const asChangeHead = asObject({
  type: asLiteral('change'),
  gameId: asString,
  kind: asLiteral(
    'playEdits',
    'lineups',
    'walkUpSong',
    'game',
    'plans',
    'roster',
    'defaultLineup'
  ) as Cleaner<GameChangeKind>,
  at: asString
})

/**
 * A worker from before `playEdits` sends `kind: 'plays'` with the game's
 * whole list of plays. During a rolling deploy a socket may land on one, so
 * it is passed on as the re-read form, under a generation no game has (they
 * count up from 0) and with the digest it names, as an echo is matched by:
 * the screen reads the game again rather than hearing no pitch at all.
 */
// Remove once no worker older than `playEdits` runs: the release after it.
const asLegacyPlays = (raw: unknown): GameChange => {
  const { gameId, at, data } = asObject({
    type: asLiteral('change'),
    gameId: asString,
    kind: asLiteral('plays'),
    at: asString,
    data: asMaybe(asObject({ digest: asMaybe(asString) }))
  })(raw)
  return {
    type: 'change',
    gameId,
    kind: 'playEdits',
    at,
    data: {
      generation: -1,
      fromDigest: null,
      digest: data?.digest ?? null,
      namesDigest: null,
      edits: null
    }
  }
}

/** A change frame as listeners hear it, or undefined when it does not read. */
function changeOf(raw: unknown): GameChange | undefined {
  try {
    return asLegacyPlays(raw)
  } catch {}
  try {
    const change = asChangeHead(raw)
    const message = { ...change, data: (raw as { data?: unknown }).data }
    return message as GameChange
  } catch {
    return undefined
  }
}

/** What a screen hears when the server refuses its scope to an app this old. */
const SCOPE_REFUSED: ScreenScopeEvent = {
  type: 'error',
  code: 'forbidden',
  message: 'Update TeamStation to keep following this screen.'
}

const asScreenScopeName = asLiteral(
  'home',
  'schedule',
  'event',
  'team',
  'group'
) as Cleaner<ScreenScopeName>

const asScopeChanged = asObject({
  type: asLiteral('changed'),
  scope: asScreenScopeName,
  gameId: asOptional(asString),
  teamId: asOptional(asString),
  groupId: asOptional(asString),
  byPost: asOptional(asBoolean)
})

const asUserTopic = asLiteral(
  'badge',
  'offlineSet',
  'tess'
) as Cleaner<UserTopic>

const asUserChanged = asObject({
  type: asLiteral('userChanged'),
  topic: asUserTopic
})

const asUserResync = asObject({
  type: asLiteral('userResync'),
  topics: asArray(asMaybe(asUserTopic))
})

/** One user topic held: its listeners, and the subscribe that stands for it. */
interface HeldTopic {
  listeners: Set<UserTopicListener>
  /** The last subscribe sent for it on this connection, until answered. */
  id: string | undefined
  /** The server answered that it holds no topics. */
  unsupported: boolean
}

/** A game being asked for again: how many times, and the wait now set. */
interface Retry {
  attempt: number
  timer: unknown
}

/** The visible screen's scope, and the subscribe that stands for it. */
interface HeldScreen {
  scope: ScreenScope
  listener: ScreenScopeListener
  /** The last subscribe sent for it on this connection, until it is dropped. */
  id: string | undefined
}

export interface GameSocketOptions {
  expectedActor?: string
  /** The API's base URL, as the client is given it. */
  baseUrl: string
  /** The session token, where the platform has no cookie (a phone). */
  token?: string
  WebSocketImpl?: WebSocketConstructor
  /** The page's address, for a relative `baseUrl`. The page's by default. */
  pageHref?: string
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  /** In milliseconds, for the typing interval. */
  now?: () => number
}

/**
 * One socket for the whole app, shared by every screen that wants a game's
 * changes and by chat. It connects when the first game is subscribed or the
 * first chat listener is added, and stays open while either is left; when
 * the last goes, it closes until the next. It reconnects after 1, 2, 4 and 8
 * seconds and then every 15, and after each reconnect subscribes every game
 * again and tells every game and chat listener to `resync`.
 *
 * A subscribe the server refuses as `internal` (its own failure) is asked
 * again on the same timings, for as long as the game is still wanted and the
 * socket stays up, until the server answers `subscribed`. Listeners hear the
 * `error`, and later the `subscribed`.
 *
 * The visible screen holds one screen scope on the same socket
 * (`subscribeScope`), which connects it too. The scope's frames never reach
 * game listeners: its answers are told apart by their ids. A reconnect, or a
 * server `resync`, subscribes the scope again and the screen waits for that
 * new `subscribed`. The scope stops asking when a socket that had opened is
 * closed with 1008, or when a REST call answers 401 (`authFailed`), until
 * the token changes (`setToken`); game subscriptions retry as they always
 * have.
 *
 * A game the server refuses as `updateRequired` is never asked for again,
 * not even after a reconnect, while its listeners stay: they hear
 * `updateRequired` once, as does `onUpdateRequired`. A scope it refuses so
 * tells `onUpdateRequired` too, and its screen hears the refusal as an
 * `error`; no scope is asked for again on this socket.
 */
export class GameSocket {
  private readonly expectedActor: string | undefined
  private readonly baseUrl: string
  private readonly pageHref: string | undefined
  private token: string | undefined
  private readonly WebSocketImpl: WebSocketConstructor | undefined
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly listeners = new Map<string, Set<GameSocketListener>>()
  private readonly chatListeners = new Set<ChatSocketListener>()
  private readonly now: () => number
  /** Which conversation each outstanding typing hint was for, by its id. */
  private readonly typing = new Map<string, string>()
  /** When the last typing hint went, or -Infinity. */
  private typedAt = Number.NEGATIVE_INFINITY
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  /** Which game each outstanding subscribe was for, by its id. */
  private readonly requests = new Map<string, string>()
  /** Games waiting to be asked again after `internal`, by game. */
  private readonly retries = new Map<string, Retry>()
  /** Games the server refused as `updateRequired`, while they are wanted. */
  private readonly refused = new Set<string>()
  private readonly updateListeners = new Set<() => void>()
  private screen: HeldScreen | undefined
  /** The user topics held, by topic. */
  private readonly topics = new Map<UserTopic, HeldTopic>()
  /** Which topic each outstanding topic subscribe was for, by its id. */
  private readonly topicRequests = new Map<string, UserTopic>()
  /**
   * Counts outages: it moves when a connection that had opened is lost, or
   * the first attempt since one opened fails, and holds through the retries.
   */
  private outages = 0
  /** Whether the current outage has been counted. */
  private outageCounted = false
  /** Whether this connection opened after one was lost. */
  private openedAfterGap = false
  /** The ids of screen-scope requests still unanswered on this connection. */
  private readonly scopeRequests = new Set<string>()
  /** Screen scopes wait for a new token: see the class comment. */
  private scopeStopped = false
  /** The server refused a scope to an app this old: none is asked for. */
  private scopeRefused = false
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
    this.expectedActor = options.expectedActor
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
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * The socket's address, from the API's base URL and the page. Throws when
   * there is none to be had.
   */
  get url(): string {
    const page = (globalThis as { location?: { href?: string } }).location
    return socketForActor(
      socketUrl(this.baseUrl, this.pageHref ?? page?.href),
      this.expectedActor
    )
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
   * Hears the server refuse a game to an app this old. Returns the way to
   * stop hearing.
   */
  onUpdateRequired(listener: () => void): () => void {
    this.updateListeners.add(listener)
    return () => {
      this.updateListeners.delete(listener)
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
      // Never subscribed, so there is nothing to undo.
      if (this.refused.delete(gameId)) {
        this.closeIfIdle()
        return
      }
      if (this.open) this.request('unsubscribe', gameId)
      this.closeIfIdle()
    }
  }

  /**
   * Holds the visible screen's scope, replacing any other. The listener hears
   * `subscribed` once the server has registered this socket, and `changed`
   * after that. Returns the way to let the scope go; once another scope has
   * replaced it, that does nothing.
   */
  subscribeScope(
    scope: ScreenScope,
    listener: ScreenScopeListener
  ): () => void {
    if (this.closed) throw new Error('This game socket is closed')
    if (this.socket == null && this.timer == null) this.endpoint()
    const held: HeldScreen = { scope: { ...scope }, listener, id: undefined }
    this.screen = held
    if (this.scopeRefused) listener(SCOPE_REFUSED)
    else if (this.scopeStopped) listener({ type: 'stopped' })
    else if (this.open) this.requestScope(held)
    else if (this.socket == null && this.timer == null) this.connect()
    // Not a first connect on its way: one that failed, or a wait to retry.
    if (
      !this.scopeRefused &&
      !this.scopeStopped &&
      !this.open &&
      this.interrupted
    )
      listener({ type: 'unreachable', outage: this.outages })
    return () => {
      if (this.screen !== held) return
      this.screen = undefined
      if (this.open && held.id != null) this.sendScope('unsubscribe', held)
      this.closeIfIdle()
    }
  }

  /**
   * A REST call answered 401. The screen scope stops until the token
   * changes; a socket that only held it is closed.
   */
  authFailed(): void {
    if (this.closed || this.scopeStopped) return
    const held = this.screen
    if (held?.id != null && this.open) this.sendScope('unsubscribe', held)
    this.stopScope()
    if (
      this.listeners.size === 0 &&
      this.chatListeners.size === 0 &&
      this.topics.size === 0
    )
      this.hangUp()
  }

  /**
   * The session token changed. A scope that stopped for want of one asks
   * again, and anything connected reconnects with the new one.
   */
  setToken(token: string | undefined): void {
    if (this.closed || token === this.token) return
    this.token = token
    this.scopeStopped = false
    this.reconnect()
  }

  /**
   * Hangs up and connects again at once, as a token change does, when
   * anything is listening: the server decides at connect whether the
   * connection hears chat, so a person who just gave their age reconnects.
   */
  reconnect(): void {
    if (this.closed) return
    this.hangUp()
    this.attempt = 0
    if (
      this.screen != null ||
      this.listeners.size > 0 ||
      this.chatListeners.size > 0 ||
      this.topics.size > 0
    )
      this.connect()
  }

  /**
   * Hears every chat hint for the signed-in person. The first listener (or
   * game) opens the socket; it stays open until the last of both goes.
   */
  onChat(listener: ChatSocketListener): () => void {
    if (this.closed) throw new Error('This game socket is closed')
    if (this.socket == null && this.timer == null) this.endpoint()
    this.chatListeners.add(listener)
    if (this.socket == null && this.timer == null) this.connect()
    let listening = true
    return () => {
      if (!listening) return
      listening = false
      this.chatListeners.delete(listener)
      this.closeIfIdle()
    }
  }

  /**
   * Hears one user topic of the signed-in person. The first listener
   * subscribes it, on this connection and each one after, and the socket
   * stays open while any topic is held; the last one lets it go. A listener
   * added during an outage hears `unreachable` at once.
   */
  onUserChanged(topic: UserTopic, listener: UserTopicListener): () => void {
    if (this.closed) throw new Error('This game socket is closed')
    if (this.socket == null && this.timer == null) this.endpoint()
    let held = this.topics.get(topic)
    if (held == null) {
      held = { listeners: new Set(), id: undefined, unsupported: false }
      this.topics.set(topic, held)
      if (this.open) this.requestTopic(topic)
    }
    held.listeners.add(listener)
    if (held.unsupported) listener({ type: 'unsupported' })
    else if (!this.open && this.interrupted)
      listener({ type: 'unreachable', outage: this.outages })
    if (this.socket == null && this.timer == null) this.connect()
    let listening = true
    return () => {
      if (!listening) return
      listening = false
      const current = this.topics.get(topic)
      if (current == null) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      this.topics.delete(topic)
      if (this.open && current.id == null && !current.unsupported)
        this.send({ type: 'unsubscribe', topic, id: `c${this.nextId++}` })
      this.closeIfIdle()
    }
  }

  /** How many outages the socket has had: the current one's number. */
  get outage(): number {
    return this.outages
  }

  /**
   * Tells the conversation's other members the person is typing. Sent only
   * while connected and at most once every `TYPING_INTERVAL_MS`, as the
   * server allows; true when it went.
   */
  sendTyping(conversationId: string): boolean {
    if (!this.open || this.socket == null) return false
    const now = this.now()
    if (now - this.typedAt < TYPING_INTERVAL_MS) return false
    this.typedAt = now
    const id = `c${this.nextId++}`
    this.typing.set(id, conversationId)
    const frame: GameSocketRequest = { type: 'typing', conversationId, id }
    this.socket.send(JSON.stringify(frame))
    return true
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
    this.refused.clear()
    this.updateListeners.clear()
    this.screen = undefined
    this.topics.clear()
    this.topicRequests.clear()
    this.chatListeners.clear()
    this.typing.clear()
    if (socket != null) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close(1000, 'closed')
    }
    this.setOpen(false)
  }

  /**
   * With no game and no chat listener left, the socket closes (or stops
   * waiting to reconnect) until somebody listens again. Nothing was missed
   * by nobody, so the next connection starts afresh.
   */
  private closeIfIdle(): void {
    if (
      (this.scopeAsked() && this.screen != null) ||
      this.listeners.size > 0 ||
      this.chatListeners.size > 0 ||
      this.topics.size > 0
    )
      return
    if (this.timer != null) this.clearTimer(this.timer)
    this.timer = undefined
    this.stopRetries()
    this.requests.clear()
    this.topicRequests.clear()
    this.typing.clear()
    this.interrupted = false
    this.outageCounted = false
    this.attempt = 0
    const socket = this.socket
    this.socket = undefined
    if (socket != null) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close(1000, 'idle')
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
      this.scopeRequests.clear()
      this.typing.clear()
      this.outageCounted = false
      this.openedAfterGap = this.interrupted
      this.topicRequests.clear()
      this.setOpen(true)
      // Each connection asks again: an older worker that refused a topic
      // may be gone, after a rolling deploy, from the one answering now.
      for (const [topic, held] of [...this.topics]) {
        held.unsupported = false
        this.requestTopic(topic)
      }
      for (const gameId of this.listeners.keys())
        if (!this.refused.has(gameId)) this.request('subscribe', gameId)
      if (this.screen != null && this.scopeAsked())
        this.requestScope(this.screen)
      if (this.interrupted) {
        for (const gameId of [...this.listeners.keys()])
          this.emit(gameId, { type: 'resync', gameId })
        this.emitChat({ type: 'resync' })
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
    socket.onclose = event => {
      this.dropped(socket, event)
    }
  }

  private dropped(socket: WebSocketLike, event?: unknown): void {
    if (this.socket !== socket) return
    // A socket that had opened and is closed for its token: the scope waits
    // for a new one. One closed before it opened cannot be told from a
    // server that is not there, and retries.
    if (this.open && (event as { code?: unknown } | null)?.code === 1008)
      this.stopScope()
    this.detach(socket)
    if (this.closed) return
    if (
      !this.scopeAsked() &&
      this.listeners.size === 0 &&
      this.chatListeners.size === 0 &&
      this.topics.size === 0
    )
      return
    if (!this.outageCounted) {
      this.outageCounted = true
      this.outages++
    }
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)
      ]
    this.attempt++
    this.timer = this.setTimer(() => {
      this.connect()
    }, delay)
    // The screen does not wait out the retry for its acknowledgement.
    if (this.scopeAsked())
      this.screen?.listener({ type: 'unreachable', outage: this.outages })
    this.emitTopics({ type: 'unreachable', outage: this.outages })
  }

  /** Lets go of the socket; the scope's acknowledgement goes with it. */
  private detach(socket: WebSocketLike): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    this.socket = undefined
    this.interrupted = true
    // The reconnect subscribes every game again.
    this.stopRetries()
    this.scopeRequests.clear()
    this.setOpen(false)
    const held = this.screen
    if (held?.id != null) {
      held.id = undefined
      held.listener({ type: 'resync' })
    }
  }

  /** Closes the socket, or the wait to reconnect it, without reconnecting. */
  private hangUp(): void {
    if (this.timer != null) this.clearTimer(this.timer)
    this.timer = undefined
    const socket = this.socket
    if (socket == null) return
    this.detach(socket)
    socket.close(1000, 'closed')
  }

  /** Whether a screen scope is asked for at all: not stopped or refused. */
  private scopeAsked(): boolean {
    return !this.scopeStopped && !this.scopeRefused
  }

  private stopScope(): void {
    this.scopeStopped = true
    const held = this.screen
    if (held == null) return
    held.id = undefined
    held.listener({ type: 'stopped' })
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return
    this.open = open
    for (const listener of [...this.statusListeners]) listener(open)
  }

  private request(type: 'subscribe' | 'unsubscribe', gameId: string): void {
    const id = `c${this.nextId++}`
    if (type === 'subscribe') {
      this.requests.set(id, gameId)
      this.send({ type, gameId, id, protocol: GAME_SOCKET_PROTOCOL })
    } else this.send({ type, gameId, id })
  }

  private requestScope(held: HeldScreen): void {
    held.id = this.sendScope('subscribe', held)
  }

  private sendScope(
    type: 'subscribe' | 'unsubscribe',
    held: HeldScreen
  ): string {
    const id = `c${this.nextId++}`
    this.scopeRequests.add(id)
    const { scope } = held
    const protocol = type === 'subscribe' ? GAME_SOCKET_PROTOCOL : undefined
    this.send(
      scope.scope === 'event'
        ? { type, scope: 'event', gameId: scope.gameId, id, protocol }
        : scope.scope === 'team'
          ? { type, scope: 'team', teamId: scope.teamId, id, protocol }
          : scope.scope === 'group'
            ? {
                type,
                scope: 'group',
                kind: scope.kind,
                groupId: scope.id,
                id,
                protocol
              }
            : { type, scope: scope.scope, id, protocol }
    )
    return id
  }

  private requestTopic(topic: UserTopic): void {
    const held = this.topics.get(topic)
    if (held == null || held.unsupported || !this.open) return
    const id = `c${this.nextId++}`
    held.id = id
    this.topicRequests.set(id, topic)
    this.send({ type: 'subscribe', topic, id, protocol: GAME_SOCKET_PROTOCOL })
  }

  private emitTopics(event: UserTopicEvent, only?: UserTopic): void {
    for (const [topic, held] of [...this.topics])
      if (only == null || only === topic)
        for (const listener of [...held.listeners]) listener(event)
  }

  private send(frame: GameSocketRequest): void {
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
    if (CHAT_FRAMES.has(head.type)) {
      let frame: ChatSocketFrame
      try {
        frame = asChatFrame(raw)
      } catch {
        return
      }
      if (frame.type === 'chat' && frame.seq === undefined) delete frame.seq
      this.emitChat(frame)
      if (head.type !== 'resync') return
    }
    if (head.type === 'typed') {
      if (head.id != null) this.typing.delete(head.id)
      return
    }
    // A user topic's own frames, before anything a game listener hears.
    if (head.id != null && this.topicRequests.has(head.id)) {
      this.topicAnswered(head.id, raw)
      return
    }
    if (head.type === 'userChanged') {
      try {
        const { topic } = asUserChanged(raw)
        this.emitTopics({ type: 'changed' }, topic)
      } catch {}
      return
    }
    if (head.type === 'userResync') {
      try {
        const { topics } = asUserResync(raw)
        for (const topic of topics)
          if (topic != null) this.emitTopics({ type: 'resync' }, topic)
      } catch {}
      return
    }
    // A screen scope's own frames, before anything a game listener hears.
    if (head.id != null && this.scopeRequests.has(head.id)) {
      this.scopeAnswered(head.id, raw)
      return
    }
    if (head.type === 'changed') {
      this.scopeChanged(raw)
      return
    }
    if (head.type === 'resync') {
      const held = this.screen
      if (held == null) return
      held.id = undefined
      held.listener({ type: 'resync' })
      if (this.open && this.scopeAsked()) this.requestScope(held)
      return
    }
    if (head.type === 'change') {
      const change = changeOf(raw)
      if (change != null) this.emit(change.gameId, change)
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
    // A refused typing hint is chat's, never every game's.
    const typedIn =
      error.conversationId ??
      (error.id == null ? undefined : this.typing.get(error.id))
    if (typedIn != null) {
      if (error.id != null) this.typing.delete(error.id)
      this.emitChat({
        type: 'error',
        conversationId: typedIn,
        code: error.code,
        message: error.message
      })
      return
    }
    const gameId =
      error.gameId ??
      (error.id == null ? undefined : this.requests.get(error.id))
    const asked = error.id == null ? undefined : this.requests.get(error.id)
    if (error.id != null) this.requests.delete(error.id)
    if (error.reason === 'updateRequired') {
      if (asked != null) this.updateRequired(asked)
      return
    }
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

  /** The server refused a game to this app: it is not asked for again. */
  private updateRequired(gameId: string): void {
    if (!this.listeners.has(gameId) || this.refused.has(gameId)) return
    this.refused.add(gameId)
    this.stopRetry(gameId)
    this.emit(gameId, { type: 'updateRequired', gameId })
    for (const listener of [...this.updateListeners]) listener()
  }

  /** The answer to a topic subscribe: held, or refused by an older server. */
  private topicAnswered(id: string, raw: unknown): void {
    const topic = this.topicRequests.get(id)
    this.topicRequests.delete(id)
    if (topic == null) return
    const held = this.topics.get(topic)
    const type = (raw as { type?: unknown }).type
    // Let go while it was being asked for: the server holds it now.
    if (held == null) {
      if (type === 'subscribed' && this.open)
        this.send({ type: 'unsubscribe', topic, id: `c${this.nextId++}` })
      return
    }
    if (held.id !== id) return
    held.id = undefined
    if (type === 'subscribed') {
      const event: UserTopicEvent = {
        type: 'subscribed',
        afterGap: this.openedAfterGap
      }
      for (const listener of [...held.listeners]) listener(event)
      return
    }
    if (type !== 'error') return
    let error: ReturnType<typeof asErrorReply>
    try {
      error = asErrorReply(raw)
    } catch {
      return
    }
    // A server older than protocol 6 reads no topic frame.
    if (error.code === 'malformed' || error.reason === 'updateRequired') {
      held.unsupported = true
      for (const listener of [...held.listeners])
        listener({ type: 'unsupported' })
    }
    // Its own failure: asked again on the next connection.
  }

  /** The answer to a scope request: only the held scope's subscribe counts. */
  private scopeAnswered(id: string, raw: unknown): void {
    this.scopeRequests.delete(id)
    const held = this.screen
    if (held?.id !== id) return
    let event: ScreenScopeEvent
    let refused = false
    if ((raw as { type?: unknown }).type === 'error') {
      let error: ReturnType<typeof asErrorReply>
      try {
        error = asErrorReply(raw)
      } catch {
        return
      }
      event = { type: 'error', code: error.code, message: error.message }
      refused = error.reason === 'updateRequired'
    } else if ((raw as { type?: unknown }).type === 'subscribed')
      event = { type: 'subscribed' }
    else return
    if (event.type === 'error') held.id = undefined
    if (refused) {
      this.scopeRefused = true
      for (const listener of [...this.updateListeners]) listener()
    }
    held.listener(event)
    if (refused) this.closeIfIdle()
  }

  private scopeChanged(raw: unknown): void {
    let changed: ReturnType<typeof asScopeChanged>
    try {
      changed = asScopeChanged(raw)
    } catch {
      return
    }
    const scope = this.screen?.scope
    if (scope?.scope !== changed.scope) return
    if (scope.scope === 'event' && scope.gameId !== changed.gameId) return
    if (scope.scope === 'team' && scope.teamId !== changed.teamId) return
    if (scope.scope === 'group' && scope.id !== changed.groupId) return
    this.screen?.listener({
      type: 'changed',
      ...(changed.gameId != null ? { gameId: changed.gameId } : {}),
      ...(changed.byPost === true ? { byPost: true } : {})
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

  private emitChat(event: ChatSocketEvent): void {
    for (const listener of [...this.chatListeners]) listener(event)
  }

  private emit(gameId: string, event: GameSocketEvent): void {
    const set = this.listeners.get(gameId)
    if (set == null) return
    for (const listener of [...set]) listener(event)
  }
}
