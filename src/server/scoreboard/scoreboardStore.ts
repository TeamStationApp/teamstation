import { readFileSync } from 'node:fs'

import {
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'
import {
  ClientClosedError,
  ClientOfflineError,
  type CommandParser,
  createClient,
  defineScript,
  SocketClosedUnexpectedlyError
} from 'redis'

import { asLiteral } from '../../common/asLiteral'
import {
  asDashboardOverrides,
  asScoreboardUpdate,
  carriesContested,
  type DashboardOverrides,
  NO_OVERRIDES,
  type ScoreboardUpdate,
  type SourceState,
  withoutTeamNames
} from '../../common/scoreboard'
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
  NUMBER_OF_KEYS: 1,
  parseCommand(parser: CommandParser, key: string, args: string[]) {
    parser.pushKey(key)
    parser.push(...args)
  },
  transformReply: undefined as unknown as () => string
})

/**
 * How to open the connection, when it needs more than the URL says: with a
 * CA file, TLS checked against that authority, for a server reached as
 * `rediss://` that signs with its own CA, which Node's store does not hold.
 * Empty means the URL alone decides, as it does for a local Redis.
 */
export function redisSocketOptions(
  caFile: string
): { tls: true; ca: string } | undefined {
  if (caFile === '') return undefined
  let ca: string
  try {
    ca = readFileSync(caFile, 'utf8')
  } catch (error) {
    throw new Error(
      `redis.caFile ${caFile} cannot be read: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return { tls: true, ca }
}

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
  caFile = ''
): ScoreboardClient {
  const client = newClient(url, redisSocketOptions(caFile))
  watchConnection(client, log, name)
  return client
}

// The client's type carries its script, as node-redis infers it.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function newClient(url: string, socket?: { tls: true; ca: string }) {
  return createClient({
    url,
    ...(socket == null ? {} : { socket }),
    disableOfflineQueue: true,
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
  name = 'scoreboard subscriber'
): ScoreboardClient {
  const subscriber = client.duplicate({ disableOfflineQueue: false })
  watchConnection(subscriber, log, name)
  return subscriber
}

function watchConnection(
  client: ScoreboardClient,
  log: (message: string) => void,
  name: string
): void {
  let down = false
  client.on('error', (error: unknown) => {
    if (down) return
    down = true
    log(
      `redis ${name}: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  client.on('ready', () => {
    if (down) log(`redis ${name}: connected again`)
    down = false
  })
}

/**
 * Ends a connection: gracefully when it is up, and at once when it is not,
 * because node-redis's graceful close waits for commands still queued, and
 * with Redis away those would never be answered.
 */
export async function quit(client: ScoreboardClient): Promise<void> {
  if (client.isReady) await client.close().catch(() => undefined)
  else if (client.isOpen) client.destroy()
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
  readonly prefix: string
  keyOf: (gameId: string) => string
  now: () => number
  /** Whether a command sent now would reach Redis. */
  isReady: () => boolean
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
  readScoreboard: (gameId: string) => Promise<ScoreboardHash | undefined>
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
  const keyOf = (gameId: string): string => `${prefix}:scoreboard:${gameId}`

  /** Runs one command, turning a lost connection into `ScoreboardUnavailable`. */
  async function command<T>(run: () => Promise<T>): Promise<T> {
    if (!client.isReady) throw new ScoreboardUnavailable()
    try {
      return await run()
    } catch (error) {
      if (
        !client.isReady ||
        error instanceof ClientOfflineError ||
        error instanceof ClientClosedError ||
        error instanceof SocketClosedUnexpectedlyError
      ) {
        throw new ScoreboardUnavailable()
      }
      throw error
    }
  }

  async function write(
    gameId: string,
    field: ScoreboardField,
    json: string,
    mode: 'replace' | 'merge' | 'mergeUncontested' | 'reset',
    startAt: number,
    sourceVersion = ''
  ): Promise<WriteResult> {
    const at = now()
    const reply = await command(
      async () =>
        await client.writeScoreboard(keyOf(gameId), [
          field,
          json,
          mode,
          String(at),
          String(startAt),
          sourceVersion,
          channel,
          gameId
        ])
    )
    if (reply === 'closed' || reply === 'stale') return { kind: reply }
    return { kind: 'written', message: parseScoreboardMessage(reply), now: at }
  }

  return {
    channel,
    prefix,
    keyOf,
    now,
    isReady: () => client.isReady,
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
    readScoreboard: async gameId => {
      const hash = await command(
        async () => await client.hGetAll(keyOf(gameId))
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
    exists: async gameId =>
      (await command(async () => await client.exists(keyOf(gameId)))) === 1,
    onReady: listener => {
      client.on('ready', listener)
    },
    close: async () => {
      await quit(client)
    }
  }
}
