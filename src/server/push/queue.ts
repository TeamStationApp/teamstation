import { createClient } from 'redis'

import { onceAMinute } from '../cache/valkeyCache'
import {
  redisSocketOptions,
  scoreboardPrefix
} from '../scoreboard/scoreboardStore'
import {
  firstTry,
  type NewPushRequest,
  type PushRequest,
  type ReadPushRequest,
  requestOf
} from './requests'

/**
 * The push queue: a Valkey stream of requests (`requests.ts`) the API writes
 * and the push sender (`sender/main.ts`) reads as one of the consumer group
 * `push-senders`. Beside it, a sorted set of requests waiting to be tried
 * again, each scored by when, and a stream of the requests given up on. Every
 * key starts with the deployment's prefix, as the change feed's do.
 */

export const PUSH_GROUP = 'push-senders'

/** About how many requests the stream keeps, read or not. */
export const MAX_REQUESTS = 100_000

/** About how many given-up requests are kept to look at. */
export const MAX_DEAD = 10_000

/**
 * How long a person stays marked woken in a conversation: past the hour a
 * wake may still be sent in (`STALE_WAKE_MS`) and a day of reading after it.
 */
export const WOKEN_TTL_SECONDS = 24 * 60 * 60

/** How long the API waits for Valkey to take a request, at most. */
export const ENQUEUE_TIMEOUT_MS = 500

/** How long the client waits for Valkey to accept a connection. */
const CONNECT_TIMEOUT_MS = 1000

export interface PushQueueKeys {
  requests: string
  /**
   * Requests waiting to be tried again, or for a chat post's hold to end,
   * scored by when.
   */
  later: string
  dead: string
  /**
   * The highest `seq` a chat wake was sent to `userId` for in
   * `conversationId`, while their devices may show it: their reading the
   * conversation then takes it down (`chatReads.ts`).
   */
  woken: (userId: string, conversationId: string) => string
}

export function pushQueueKeys(prefix: string): PushQueueKeys {
  return {
    requests: `${prefix}:push:requests`,
    later: `${prefix}:push:later`,
    dead: `${prefix}:push:dead`,
    woken: (userId, conversationId) =>
      `${prefix}:push:woken:${userId}:${conversationId}`
  }
}

/** The server's `redis` settings, and the database that names the prefix. */
export interface PushQueueSettings {
  redis: { url: string; prefix: string; caFile?: string }
  databaseUrl: string
}

/**
 * A node-redis client for the queue: it fails a command at once rather than
 * queueing it while Valkey is away, and gives up on one unanswered after
 * `timeoutMs`. node-redis keeps reconnecting on its own; failures are said
 * once a minute at most.
 */
export function pushQueueClient(
  settings: PushQueueSettings,
  timeoutMs: number,
  log: (message: string) => void
): PushQueueClient {
  const socket = redisSocketOptions(settings.redis.caFile ?? '')
  const client = newClient(settings.redis.url, timeoutMs, socket)
  const say = onceAMinute(log)
  // An unheard `error` would end the process.
  client.on('error', (error: unknown) => {
    say(`push queue: ${error instanceof Error ? error.message : String(error)}`)
  })
  return client
}

// The client's type is as node-redis infers it.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function newClient(
  url: string,
  timeoutMs: number,
  socket?: { tls: true; ca: string }
) {
  return createClient({
    url,
    socket: { connectTimeout: CONNECT_TIMEOUT_MS, ...socket },
    disableOfflineQueue: true,
    commandOptions: { timeout: timeoutMs }
  })
}
export type PushQueueClient = ReturnType<typeof newClient>

/** One entry as it was read: its id, and its request or why it has none. */
export interface QueueEntry {
  id: string
  /** The request's JSON as it was written. */
  raw: string | undefined
  read: ReturnType<typeof requestOf>
}

/**
 * Moves the requests due by `ARGV[1]` (at most `ARGV[2]`) from the waiting
 * set to the stream, in one step, so two senders never both move one.
 */
const PROMOTE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
for _, request in ipairs(due) do
  redis.call('ZREM', KEYS[1], request)
  redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[3], '*', 'r', request)
end
return #due
`

/**
 * Marks each person in `KEYS` woken up to `ARGV[1]`, for `ARGV[2]` seconds:
 * a lower `seq` than the one there already only renews it. Answers, key by
 * key, 1 where there was no mark before.
 */
const WOKEN = `
local fresh = {}
for i, key in ipairs(KEYS) do
  local held = redis.call('GET', key)
  fresh[i] = held and 0 or 1
  if tonumber(held or '0') < tonumber(ARGV[1]) then
    redis.call('SET', key, ARGV[1], 'EX', ARGV[2])
  else
    redis.call('EXPIRE', key, ARGV[2])
  end
end
return fresh
`

/** Drops the mark `KEYS[1]` once a read at `ARGV[1]` covers it. */
const READ_PAST = `
local was = tonumber(redis.call('GET', KEYS[1]) or '-1')
if was >= 0 and was <= tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`

/**
 * Queues `ARGV[1]` only while the mark `KEYS[1]` is there: a read that no
 * wake came before has nothing to take down, and costs one step.
 */
const ADD_IF_WOKEN = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', 'r', ARGV[1])
return 1
`

function entryOf(id: string, fields: Record<string, string>): QueueEntry {
  return { id, raw: fields.r, read: requestOf(fields.r) }
}

/** The queue over a connected client, as the sender and the tests use it. */
export class PushQueue {
  readonly keys: PushQueueKeys

  constructor(
    private readonly client: PushQueueClient,
    prefix: string
  ) {
    this.keys = pushQueueKeys(prefix)
  }

  /**
   * Makes the consumer group, and the stream with it, unless they are there.
   * A new group reads the stream from its start, so nothing written before
   * the first sender ran is passed over.
   */
  async ensureGroup(): Promise<void> {
    try {
      await this.client.xGroupCreate(this.keys.requests, PUSH_GROUP, '0', {
        MKSTREAM: true
      })
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error
    }
  }

  /** Queues a request; answers its entry's id. */
  async add(request: PushRequest): Promise<string> {
    return await this.client.xAdd(
      this.keys.requests,
      '*',
      { r: JSON.stringify(request) },
      {
        TRIM: {
          strategy: 'MAXLEN',
          strategyModifier: '~',
          threshold: MAX_REQUESTS
        }
      }
    )
  }

  /**
   * Up to `count` entries no consumer of the group has been given, waiting
   * up to `blockMs` for one to come, or with null not waiting at all; each
   * stays pending on `consumer` until it is settled.
   */
  async read(
    consumer: string,
    count: number,
    blockMs: number | null
  ): Promise<QueueEntry[]> {
    const reply = await this.client.xReadGroup(
      PUSH_GROUP,
      consumer,
      { key: this.keys.requests, id: '>' },
      blockMs == null ? { COUNT: count } : { COUNT: count, BLOCK: blockMs }
    )
    if (reply == null) return []
    return (
      reply as Array<{
        messages: Array<{ id: string; message: Record<string, string> }>
      }>
    ).flatMap(stream =>
      stream.messages.map(message => entryOf(message.id, message.message))
    )
  }

  /**
   * Takes over up to `count` entries another consumer was given more than
   * `minIdleMs` ago and never settled: its process died, or was stopped with
   * them in hand. An entry trimmed away meanwhile is let go.
   */
  async reclaim(
    consumer: string,
    minIdleMs: number,
    count: number
  ): Promise<QueueEntry[]> {
    const reply = await this.client.xAutoClaim(
      this.keys.requests,
      PUSH_GROUP,
      consumer,
      minIdleMs,
      '0-0',
      { COUNT: count }
    )
    if (reply.deletedMessages.length > 0)
      await this.client.xAck(
        this.keys.requests,
        PUSH_GROUP,
        reply.deletedMessages.map(String)
      )
    return reply.messages.flatMap(message =>
      message == null
        ? []
        : [entryOf(message.id, message.message as Record<string, string>)]
    )
  }

  /**
   * Claims these entries for `consumer` afresh, as just read, so none is
   * taken over (`reclaim`) while its work goes on. An entry settled
   * meanwhile is no longer pending, and is left alone.
   */
  async renew(consumer: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.client.xClaimJustId(
      this.keys.requests,
      PUSH_GROUP,
      consumer,
      0,
      [...ids]
    )
  }

  /**
   * Lets go of the group's consumers, other than `self`, that hold nothing
   * and have done nothing for `minIdleMs`: senders that stopped or died, one
   * a restart. A sender still running that is let go is made again by its
   * next read. Answers the names let go.
   */
  async dropIdleConsumers(self: string, minIdleMs: number): Promise<string[]> {
    const consumers = await this.client.xInfoConsumers(
      this.keys.requests,
      PUSH_GROUP
    )
    const idle = consumers
      .filter(
        consumer =>
          consumer.name !== self &&
          Number(consumer.pending) === 0 &&
          Number(consumer.idle) >= minIdleMs
      )
      .map(consumer => String(consumer.name))
    for (const name of idle)
      await this.client.xGroupDelConsumer(this.keys.requests, PUSH_GROUP, name)
    return idle
  }

  /** When the soonest request waiting to be tried again is due, if any. */
  async nextDue(): Promise<number | null> {
    const [soonest] = await this.client.zRangeWithScores(this.keys.later, 0, 0)
    return soonest == null ? null : soonest.score
  }

  /** Puts back on the stream every request due to be tried again by `now`. */
  async promote(now: number, count = 100): Promise<number> {
    return Number(
      await this.client.eval(PROMOTE, {
        keys: [this.keys.later, this.keys.requests],
        arguments: [String(now), String(count), String(MAX_REQUESTS)]
      })
    )
  }

  /** Settles an entry whose work is done. */
  async done(id: string): Promise<void> {
    await this.client
      .multi()
      .xAck(this.keys.requests, PUSH_GROUP, id)
      .xDel(this.keys.requests, id)
      .exec()
  }

  /**
   * Queues a read's request when its reader was woken in its conversation,
   * and answers whether it did.
   */
  async addIfWoken(request: ReadPushRequest): Promise<boolean> {
    return (
      Number(
        await this.client.eval(ADD_IF_WOKEN, {
          keys: [this.keys.woken(request.u, request.c), this.keys.requests],
          arguments: [JSON.stringify(request), String(MAX_REQUESTS)]
        })
      ) === 1
    )
  }

  /**
   * Marks these people woken in `conversationId` up to `seq`, and answers
   * those of them who had no mark there before.
   */
  async markWoken(
    userIds: readonly string[],
    conversationId: string,
    seq: number
  ): Promise<string[]> {
    if (userIds.length === 0) return []
    const fresh = (await this.client.eval(WOKEN, {
      keys: userIds.map(userId => this.keys.woken(userId, conversationId)),
      arguments: [String(seq), String(WOKEN_TTL_SECONDS)]
    })) as number[]
    return userIds.filter((_, index) => Number(fresh[index]) === 1)
  }

  /** The highest `seq` `userId` was woken for in `conversationId`, if any. */
  async wokenAt(
    userId: string,
    conversationId: string
  ): Promise<number | null> {
    const seq = await this.client.get(this.keys.woken(userId, conversationId))
    return seq == null ? null : Number(seq)
  }

  /**
   * Drops the person's mark in `conversationId` when a read at `seq` covers
   * it; a wake marked meanwhile for a later message keeps it.
   */
  async readPast(
    userId: string,
    conversationId: string,
    seq: number
  ): Promise<boolean> {
    return (
      Number(
        await this.client.eval(READ_PAST, {
          keys: [this.keys.woken(userId, conversationId)],
          arguments: [String(seq)]
        })
      ) === 1
    )
  }

  /**
   * Settles an entry by waiting `request` until `at`: its next try, or the
   * end of a chat post's hold.
   */
  async retry(id: string, request: PushRequest, at: number): Promise<void> {
    await this.client
      .multi()
      .zAdd(this.keys.later, { score: at, value: JSON.stringify(request) })
      .xAck(this.keys.requests, PUSH_GROUP, id)
      .xDel(this.keys.requests, id)
      .exec()
  }

  /** Settles an entry by giving it up, kept with why on the dead stream. */
  async dead(
    id: string,
    raw: string | undefined,
    error: string,
    now: Date
  ): Promise<void> {
    await this.client
      .multi()
      .xAdd(
        this.keys.dead,
        '*',
        { r: raw ?? '', error, at: now.toISOString() },
        {
          TRIM: {
            strategy: 'MAXLEN',
            strategyModifier: '~',
            threshold: MAX_DEAD
          }
        }
      )
      .xAck(this.keys.requests, PUSH_GROUP, id)
      .xDel(this.keys.requests, id)
      .exec()
  }
}

/** What the API queues requests through. */
export interface PushEnqueuer {
  /**
   * Queues a request's first try. Never throws and never waits long: with
   * Valkey away, slow or failing, the request is dropped and said, once a
   * minute at most, and the answer is false.
   */
  add: (request: NewPushRequest) => Promise<boolean>
  /**
   * Queues a read's request, as `add` does, when a wake reached its reader
   * in its conversation (`PushQueue.addIfWoken`); answers whether it did.
   */
  addRead: (
    request: Omit<ReadPushRequest, 'v' | 'attempt' | 'devices'>
  ) => Promise<boolean>
  /**
   * Runs `then` once Valkey is first there to take requests: at once when it
   * is already.
   */
  whenReady: (then: () => void) => void
  close: () => Promise<void>
}

/**
 * The API's side of the queue, on a client of its own. Nothing a caller does
 * waits on Valkey: a request finds it ready or is dropped at once, and one
 * unanswered is given up on after `ENQUEUE_TIMEOUT_MS`.
 */
export function makePushEnqueuer(
  settings: PushQueueSettings,
  log: (message: string) => void
): PushEnqueuer {
  const client = pushQueueClient(settings, ENQUEUE_TIMEOUT_MS, log)
  const queue = new PushQueue(
    client,
    scoreboardPrefix(settings.redis.prefix, settings.databaseUrl)
  )
  const dropped = onceAMinute(log)
  client.connect().catch(() => undefined)
  const queued = async (
    request: NewPushRequest,
    add: () => Promise<boolean>
  ): Promise<boolean> => {
    try {
      if (!client.isReady) throw new Error('Valkey is not connected')
      return await add()
    } catch (error) {
      dropped(
        `push queue: dropped a ${request.t} request: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }
  return {
    add: async request =>
      await queued(request, async () => {
        await queue.add(firstTry(request))
        return true
      }),
    addRead: async request =>
      await queued(
        request,
        async () =>
          await queue.addIfWoken({
            ...request,
            v: 1,
            attempt: 1,
            devices: undefined
          })
      ),
    whenReady: then => {
      if (client.isReady) then()
      else client.once('ready', then)
    },
    // At once when Valkey is away: a graceful close would wait for it.
    close: async () => {
      if (client.isReady) await client.close().catch(() => undefined)
      else if (client.isOpen) client.destroy()
    }
  }
}

/**
 * The request that wakes the members' devices for a new post: a stored
 * message (`chat/messages.ts`), named by where it is and who sent it.
 */
export function chatRequestOf(message: {
  conversationId: string
  seq: number
  senderUserId: string
}): NewPushRequest {
  return {
    t: 'chat',
    c: message.conversationId,
    seq: message.seq,
    sender: message.senderUserId
  }
}

/**
 * The request that takes a read conversation's notifications down from the
 * reader's other devices: whose cursor moved, where to, and from which
 * session, whose device cleared its own.
 */
export function readRequestOf(read: {
  userId: string
  sessionId: string
  conversationId: string
  seq: number
}): Omit<ReadPushRequest, 'v' | 'attempt' | 'devices'> {
  return {
    t: 'read',
    u: read.userId,
    c: read.conversationId,
    seq: read.seq,
    session: read.sessionId
  }
}
