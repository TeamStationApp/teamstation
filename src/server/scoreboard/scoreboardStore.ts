import { randomUUID } from 'node:crypto'

import {
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'
import { type CommandParser, createClient, defineScript } from 'redis'

import { asLiteral } from '../../common/asLiteral'
import {
  asDashboardOverrides,
  asExitReading,
  asScoreboardUpdate,
  carriesContested,
  type DashboardOverrides,
  NO_OVERRIDES,
  type ScoreboardUpdate,
  type SourceState,
  withoutTeamNames
} from '../../common/scoreboard'
import {
  closeValkey,
  isConnectionError,
  reconnectWhenSilent,
  runValkey,
  VALKEY_COMMAND_TIMEOUT_MS,
  valkeyClientName,
  type ValkeyClientOptions,
  valkeyClientOptions,
  valkeyReachable,
  ValkeyTimeout,
  ValkeyUnavailable,
  watchValkeyConnection
} from '../valkey/client'
import { WRITE_SCOREBOARD } from './scoreboardScript'

/**
 * A game's scoreboard in Redis: one hash per game, written only through
 * `WRITE_SCOREBOARD`, and one pub/sub channel on which every write is
 * announced with the whole hash after it.
 *
 * The store keeps nothing in Postgres. Every key expires, so a scoreboard
 * nobody writes to is gone two hours after its game's start, and one that is
 * written to lasts two hours past its last write, never more than three days
 * past its start. What outlives the key is the hub's: it logs every write
 * that is not the game's own scoring in `scoreboard_log` (`scoreboardLog.ts`).
 */

/** Redis is not there: the scoreboard answers 503 and its sockets 1011. */
export class ScoreboardUnavailable extends Error {
  constructor() {
    super('The scoreboard is unavailable')
    this.name = 'ScoreboardUnavailable'
  }
}

const writeScoreboardScript = defineScript({
  SCRIPT: WRITE_SCOREBOARD,
  NUMBER_OF_KEYS: 2,
  parseCommand(
    parser: CommandParser,
    key: string,
    resultKey: string,
    args: string[]
  ) {
    parser.pushKey(key)
    parser.pushKey(resultKey)
    parser.push(...args)
  },
  transformReply: undefined as unknown as () => string
})

/**
 * The command client, which fails a command at once rather than queueing it
 * while Redis is away, so a request answers 503 instead of hanging. Its
 * `error` listener logs once each time the connection goes, and node-redis
 * keeps reconnecting on its own; an unheard `error` would end the worker.
 */
export function makeScoreboardClient(
  url: string,
  log: (message: string) => void,
  name = 'scoreboard',
  caFile = '',
  options: ValkeyClientOptions = {}
): ScoreboardClient {
  const client = newClient(url, name, caFile, options)
  watchValkeyConnection(client, log, name)
  reconnectWhenSilent(client, options.silenceGraceMs)
  return client
}

// The client's type carries its script, as node-redis infers it.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function newClient(
  url: string,
  name: string,
  caFile: string,
  options: ValkeyClientOptions
) {
  return createClient({
    ...valkeyClientOptions(url, name, caFile, options),
    scripts: { writeScoreboard: writeScoreboardScript }
  })
}
export type ScoreboardClient = ReturnType<typeof newClient>

/**
 * The subscriber: a second connection, because a connection that subscribes
 * can do nothing else. It keeps its offline queue, so the subscription made
 * before Redis answers is sent once it does, and node-redis subscribes again
 * after every reconnect.
 */
export function makeScoreboardSubscriber(
  client: ScoreboardClient,
  log: (message: string) => void,
  name = 'scoreboard subscriber',
  options: ValkeyClientOptions = {}
): ScoreboardClient {
  // Everything else, keepalive included, comes from the command client.
  const subscriber = client.duplicate({
    disableOfflineQueue: false,
    name: options.name ?? valkeyClientName(name),
    ...(options.pingInterval == null
      ? {}
      : {
          pingInterval: options.pingInterval
        })
  })
  watchValkeyConnection(subscriber, log, name)
  reconnectWhenSilent(subscriber, options.silenceGraceMs)
  return subscriber
}

/**
 * Drains pending commands within one command budget, then closes the socket.
 * A silent peer may still look ready, including with an unanswered PING.
 */
export async function quit(client: ScoreboardClient): Promise<void> {
  await closeValkey(client)
}

/**
 * The prefix every key and the channel start with. Empty in the config means
 * `ts:<database name>`, so two deployments sharing one Redis, each with its own
 * database, never see each other's scoreboards.
 */
export function scoreboardPrefix(prefix: string, databaseUrl: string): string {
  if (prefix !== '') return prefix
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
  return `ts:${name}`
}

/** A stamp the script wrote as a decimal string, read back as a number. */
const asStamp: Cleaner<number> = asEither(asNumber, (raw: unknown) => {
  const value = Number(asString(raw))
  if (!Number.isSafeInteger(value)) throw new TypeError('Expected a stamp')
  return value
})

const asStoredSource = asObject({
  state: asScoreboardUpdate,
  exitReading: asOptional(asExitReading),
  receivedAt: asStamp,
  sourceVersion: asOptional(asStamp)
})

/** The game source, which also carries the version of the game it read. */
export interface GameSourceState extends SourceState {
  sourceVersion?: number
}

/** A game's hash: every source that has written, and the write's version. */
export interface ScoreboardHash {
  gameId: string
  version: number
  game?: GameSourceState
  watcher?: SourceState
  overrides?: DashboardOverrides
}

export type ScoreboardField = 'game' | 'watcher' | 'overrides'

/** What a write publishes: the hash after it, and the field it wrote. */
export interface ScoreboardMessage extends ScoreboardHash {
  field: ScoreboardField
}

const asScoreboardMessage = asObject({
  gameId: asString,
  version: asStamp,
  field: asLiteral('game', 'watcher', 'overrides'),
  game: asOptional(asStoredSource),
  watcher: asOptional(asStoredSource),
  overrides: asOptional(asDashboardOverrides)
})

/** One published message, read. */
export function parseScoreboardMessage(json: string): ScoreboardMessage {
  const raw = asScoreboardMessage(JSON.parse(json))
  return withoutAbsent({
    gameId: raw.gameId,
    version: raw.version,
    field: raw.field,
    game: sourceOf(raw.game),
    watcher: sourceOf(raw.watcher),
    overrides: raw.overrides
  })
}

function sourceOf(
  raw: ReturnType<typeof asStoredSource> | undefined
): GameSourceState | undefined {
  if (raw == null) return undefined
  return withoutAbsent({
    state: withoutAbsent(raw.state),
    exitReading: raw.exitReading,
    receivedAt: raw.receivedAt,
    sourceVersion: raw.sourceVersion
  })
}

/** An object without its undefined keys, as JSON would carry it. */
function withoutAbsent<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T
}

/**
 * What a write did. A written one carries the hash after it and `now`, the
 * time the store passed the script: when the write was taken in, which the
 * scoreboard log records.
 */
export type WriteResult =
  | { kind: 'written'; message: ScoreboardMessage; now: number }
  | { kind: 'closed' }
  | { kind: 'stale' }

/**
 * How a Watcher packet is merged. One that carries a contested field makes
 * Watcher the newer source; one that carries only pitch speed, exit velocity
 * or batter details is merged without changing when Watcher last reported.
 */
export function watcherMode(
  update: ScoreboardUpdate
): 'merge' | 'mergeUncontested' {
  return carriesContested(update) ? 'merge' : 'mergeUncontested'
}

export interface ScoreboardStore {
  /** The channel every write is published on. */
  readonly channel: string
  /**
   * The channel a game's board timeline is announced on, as `{ gameId }`,
   * once everything the timeline reads from Postgres has committed.
   */
  readonly timelineChannel: string
  readonly prefix: string
  keyOf: (gameId: string) => string
  now: () => number
  /** Whether a command sent now could be answered, at once or after a reconnect. */
  reachable: () => boolean
  /** Waits, within one command budget, for a connection that is coming back. */
  whenReady: () => Promise<void>
  writeGame: (
    gameId: string,
    state: ScoreboardUpdate,
    startAt: number,
    sourceVersion: number
  ) => Promise<WriteResult>
  mergeWatcher: (
    gameId: string,
    update: ScoreboardUpdate,
    startAt: number
  ) => Promise<WriteResult>
  writeOverrides: (
    gameId: string,
    overrides: DashboardOverrides,
    startAt: number
  ) => Promise<WriteResult>
  /**
   * The dashboard's Reset Game State: no overrides, and TS Watcher's stored
   * state deleted, in one write.
   */
  resetScoreboard: (gameId: string, startAt: number) => Promise<WriteResult>
  /**
   * The game's own scoring deleted, for a game reset to no plays and no
   * lineups: `closed` when the board holds none. An older game write than
   * the one stored is `stale`.
   */
  clearGame: (
    gameId: string,
    startAt: number,
    sourceVersion: number
  ) => Promise<WriteResult>
  readScoreboard: (gameId: string) => Promise<ScoreboardHash | undefined>
  /** Tells every worker that the game's board timeline has changed. */
  announceTimeline: (gameId: string, fromMs?: number) => Promise<void>
  exists: (gameId: string) => Promise<boolean>
  /** Called each time the command connection is ready, the first included. */
  onReady: (listener: () => void) => void
  close: () => Promise<void>
}

export function makeScoreboardStore(options: {
  client: ScoreboardClient
  prefix: string
  now?: () => number
}): ScoreboardStore {
  const { client, prefix } = options
  const now = options.now ?? Date.now
  const channel = `${prefix}:scoreboard`
  const timelineChannel = `${prefix}:scoreboardTimeline`
  const keyOf = (gameId: string): string => `${prefix}:scoreboard:${gameId}`

  /**
   * Runs one command, turning a lost connection into `ScoreboardUnavailable`.
   * It is sent again after a lost connection only when the caller says it is
   * `replaySafe`: reads and the result-keyed write are, and a PUBLISH is not,
   * so it never goes out twice.
   */
  async function command<T>(
    run: () => Promise<T>,
    replaySafe = false
  ): Promise<T> {
    try {
      return await runValkey(client, run, VALKEY_COMMAND_TIMEOUT_MS, replaySafe)
    } catch (error) {
      throw unavailable(error)
    }
  }

  function unavailable(error: unknown): unknown {
    return error instanceof ValkeyUnavailable ||
      isConnectionError(error) ||
      !client.isReady
      ? new ScoreboardUnavailable()
      : error
  }

  async function write(
    gameId: string,
    field: ScoreboardField,
    json: string,
    mode: 'replace' | 'merge' | 'mergeUncontested' | 'reset' | 'clearGame',
    startAt: number,
    sourceVersion = ''
  ): Promise<WriteResult> {
    const at = now()
    // The prefix comes first, and the hash tag, the whole game key, puts the
    // result in that key's cluster slot.
    const resultKey = `${prefix}:scoreboardResult:{${keyOf(gameId)}}:${randomUUID()}`
    const run = async (): Promise<string> =>
      await client.writeScoreboard(keyOf(gameId), resultKey, [
        field,
        json,
        mode,
        String(at),
        String(startAt),
        sourceVersion,
        channel,
        gameId
      ])
    let reply: string
    try {
      reply = await runValkey(client, run, VALKEY_COMMAND_TIMEOUT_MS, true)
    } catch (error) {
      if (!(error instanceof ValkeyTimeout && error.what === 'answer'))
        throw unavailable(error)
      // A slow write that was sent may still land. Its replay queues behind it
      // on the same connection and answers with the stored result, so it is
      // not lost: a write may take two command budgets, never more.
      reply = await command(run, true)
    }
    if (reply === 'closed' || reply === 'stale') return { kind: reply }
    return { kind: 'written', message: parseScoreboardMessage(reply), now: at }
  }

  return {
    channel,
    timelineChannel,
    prefix,
    keyOf,
    now,
    reachable: () => valkeyReachable(client),
    whenReady: async () => {
      await command(async () => undefined, true)
    },
    writeGame: async (gameId, state, startAt, sourceVersion) =>
      await write(
        gameId,
        'game',
        JSON.stringify(state),
        'replace',
        startAt,
        String(sourceVersion)
      ),
    mergeWatcher: async (gameId, update, startAt) => {
      const stripped = withoutTeamNames(update)
      return await write(
        gameId,
        'watcher',
        JSON.stringify(stripped),
        watcherMode(stripped),
        startAt
      )
    },
    writeOverrides: async (gameId, overrides, startAt) =>
      await write(
        gameId,
        'overrides',
        JSON.stringify(overrides),
        'replace',
        startAt
      ),
    resetScoreboard: async (gameId, startAt) =>
      await write(
        gameId,
        'overrides',
        JSON.stringify(NO_OVERRIDES),
        'reset',
        startAt
      ),
    clearGame: async (gameId, startAt, sourceVersion) =>
      await write(
        gameId,
        'game',
        'null',
        'clearGame',
        startAt,
        String(sourceVersion)
      ),
    readScoreboard: async gameId => {
      const hash = await command(
        async () => await client.hGetAll(keyOf(gameId)),
        true
      )
      if (Object.keys(hash).length === 0) return undefined
      const parse = <T>(field: string, cleaner: Cleaner<T>): T | undefined =>
        hash[field] == null ? undefined : cleaner(JSON.parse(hash[field]))
      return withoutAbsent({
        gameId,
        version: asStamp(hash.version ?? '0'),
        game: sourceOf(parse('game', asStoredSource)),
        watcher: sourceOf(parse('watcher', asStoredSource)),
        overrides: parse('overrides', asDashboardOverrides)
      })
    },
    announceTimeline: async (gameId, fromMs) => {
      await command(
        async () =>
          await client.publish(
            timelineChannel,
            JSON.stringify({ gameId, fromMs })
          )
      )
    },
    exists: async gameId =>
      (await command(async () => await client.exists(keyOf(gameId)), true)) ===
      1,
    onReady: listener => {
      client.on('ready', listener)
    },
    close: async () => {
      await quit(client)
    }
  }
}
