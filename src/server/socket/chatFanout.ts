import { asEither, asNumber, asObject, asOptional, asString } from 'cleaners'
import { type Kysely, sql } from 'kysely'
import { Client } from 'pg'

import { asLiteral } from '../../common/asLiteral'
import type { ChatSocketFrame } from '../../common/gameSocket'
import { asUserId } from '../../common/userId'
import { CHAT_CHANGES_CHANNEL } from '../chat/membershipLog'
import type { Database } from '../db/database'

/**
 * What every chat writer notifies on `chat_changes`, inside its
 * transaction: a conversation's change (`c`), with the typist's id on a
 * `typing` hint (`u`), or one user's own devices or links (`u`).
 */
export type ChatChangePayload =
  | {
      c: string
      k: 'message' | 'members' | 'epoch' | 'grant' | 'read'
      seq?: number
    }
  | { c: string; k: 'typing'; u: string }
  | { u: string; k: 'link' | 'devices' | 'preferences' }

export const asChatChangePayload = asEither(
  asObject({
    c: asString,
    k: asLiteral('message', 'members', 'epoch', 'grant', 'read'),
    seq: asOptional(asNumber)
  }),
  asObject({ c: asString, k: asLiteral('typing'), u: asUserId }),
  asObject({ u: asUserId, k: asLiteral('link', 'devices', 'preferences') })
)

/** Somebody signed in on one socket of this worker. */
export interface ChatSubscriber {
  userId: string
  send: (frame: ChatSocketFrame) => void
}

/** Who is in a conversation now: its current members' user ids. */
export type MemberReader = (
  db: Kysely<Database>,
  conversationId: string
) => Promise<Set<string>>

export interface ChatFanoutOptions {
  db: Kysely<Database>
  /**
   * Where the `LISTEN` connection goes: the database's own address
   * (`serverConfig.databaseUrl`), never a transaction-mode pool, where
   * `LISTEN` does not work.
   */
  databaseUrl: string
  /** How long to wait before listening again after the connection is lost. */
  retryMs?: number
  /** How many conversations' member sets are kept. */
  cacheSize?: number
  readMembers?: MemberReader
  now?: () => Date
  log?: (message: string) => void
}

/** The current members of a conversation. */
export const readMembers: MemberReader = async (db, conversationId) =>
  new Set(
    (
      await db
        .selectFrom('chat_members')
        .select(['user_id'])
        .where('conversation_id', '=', conversationId)
        .where('left_at', 'is', null)
        .execute()
    ).map(row => row.user_id)
  )

/**
 * Relays a typist's hint to the conversation's other members, on every
 * worker, without storing anything: the notify is all there is.
 */
export async function notifyTyping(
  db: Kysely<Database>,
  conversationId: string,
  userId: string
): Promise<void> {
  const payload = JSON.stringify({ c: conversationId, k: 'typing', u: userId })
  await sql`select pg_notify(${CHAT_CHANGES_CHANNEL}, ${payload})`.execute(db)
}

/**
 * One worker's end of `chat_changes`.
 *
 * Every signed-in socket on the worker is registered here by its user id,
 * with nothing to subscribe to. The worker holds one `LISTEN chat_changes`.
 * A conversation's hint goes to the sockets of its current members, read
 * once per conversation and cached until a `members` hint for it (or a lost
 * listen) drops the set; a `typing` hint goes to every member but the
 * typist; a user's hint goes to that user's sockets. Nothing of a message is
 * sent, only that something changed: clients fetch it over REST.
 *
 * Like `GameFanout`, a lost `LISTEN` connection is listened again after
 * `retryMs`. Hints sent meanwhile were never heard, so every chat socket on
 * the worker is told to `resync`.
 */
export class ChatFanout {
  /** Settles once the first `LISTEN` is in place, or has failed. */
  readonly listening: Promise<void>
  private readonly db: Kysely<Database>
  private readonly databaseUrl: string
  private readonly retryMs: number
  private readonly cacheSize: number
  private readonly readMembers: MemberReader
  private readonly now: () => Date
  private readonly log: (message: string) => void
  /** The sockets on this worker, by user id. */
  private readonly subscribers = new Map<string, Set<ChatSubscriber>>()
  /** Member sets by conversation, oldest first. */
  private readonly members = new Map<string, Promise<Set<string>>>()
  private client: Client | undefined
  private readonly hangingUp = new Set<Promise<void>>()
  private retry: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(options: ChatFanoutOptions) {
    this.db = options.db
    this.databaseUrl = options.databaseUrl
    this.retryMs = options.retryMs ?? 1000
    this.cacheSize = options.cacheSize ?? 1000
    this.readMembers = options.readMembers ?? readMembers
    this.now = options.now ?? (() => new Date())
    this.log =
      options.log ??
      (message => {
        console.error(`chat socket: ${message}`)
      })
    this.listening = this.listen()
  }

  /** A signed-in socket opened. Twice is once. */
  add(subscriber: ChatSubscriber): void {
    let set = this.subscribers.get(subscriber.userId)
    if (set == null) {
      set = new Set()
      this.subscribers.set(subscriber.userId, set)
    }
    set.add(subscriber)
  }

  /** The socket closed. */
  remove(subscriber: ChatSubscriber): void {
    const set = this.subscribers.get(subscriber.userId)
    if (set == null) return
    set.delete(subscriber)
    if (set.size === 0) this.subscribers.delete(subscriber.userId)
  }

  /** How many sockets are registered. */
  size(): number {
    let count = 0
    for (const set of this.subscribers.values()) count += set.size
    return count
  }

  /** The conversations whose member sets are cached now. */
  cached(): string[] {
    return [...this.members.keys()]
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retry)
    this.subscribers.clear()
    this.members.clear()
    const client = this.client
    this.client = undefined
    if (client != null) this.hangUp(client)
    await Promise.all([...this.hangingUp])
  }

  /** A notify, as the `LISTEN` connection hands it over. */
  notified(payload: string | undefined): void {
    if (payload == null || this.closed) return
    this.deliver(payload).catch((error: unknown) => {
      this.log(`sending ${payload}: ${String(error)}`)
    })
  }

  /** Sends what a payload announces to the sockets it concerns. */
  async deliver(payload: string): Promise<void> {
    let change: ChatChangePayload
    try {
      change = asChatChangePayload(JSON.parse(payload))
    } catch {
      this.log(`ignoring a notify that does not read: ${payload}`)
      return
    }
    if (!('c' in change)) {
      this.sendTo(change.u, { type: 'chatUser', kind: change.k })
      return
    }
    if (change.k === 'members') this.members.delete(change.c)
    // Nobody here to tell: the set is not read at all.
    if (this.subscribers.size === 0) return
    const members = await this.membersOf(change.c)
    if (change.k === 'typing') {
      const frame: ChatSocketFrame = {
        type: 'chatTyping',
        conversationId: change.c,
        userId: change.u
      }
      for (const userId of members)
        if (userId !== change.u) this.sendTo(userId, frame)
      return
    }
    const frame: ChatSocketFrame = {
      type: 'chat',
      conversationId: change.c,
      kind: change.k,
      ...(change.seq == null ? {} : { seq: change.seq }),
      at: this.now().toISOString()
    }
    for (const userId of members) this.sendTo(userId, frame)
  }

  private sendTo(userId: string, frame: ChatSocketFrame): void {
    const set = this.subscribers.get(userId)
    if (set == null) return
    for (const subscriber of [...set]) subscriber.send(frame)
  }

  /** A conversation's members, from the cache or read once. */
  private async membersOf(conversationId: string): Promise<Set<string>> {
    let reading = this.members.get(conversationId)
    if (reading != null) {
      // Most recently used last.
      this.members.delete(conversationId)
      this.members.set(conversationId, reading)
      return await reading
    }
    reading = this.readMembers(this.db, conversationId)
    this.members.set(conversationId, reading)
    while (this.members.size > this.cacheSize) {
      const [oldest] = this.members.keys()
      this.members.delete(oldest)
    }
    try {
      return await reading
    } catch (error) {
      // A failed read is never kept.
      if (this.members.get(conversationId) === reading)
        this.members.delete(conversationId)
      throw error
    }
  }

  /** Ends a connection, remembered until it has. */
  private hangUp(client: Client): void {
    const ending: Promise<void> = client
      .end()
      .catch(() => undefined)
      .finally(() => {
        this.hangingUp.delete(ending)
      })
    this.hangingUp.add(ending)
  }

  private async listen(): Promise<void> {
    if (this.closed) return
    const client = new Client({ connectionString: this.databaseUrl })
    this.client = client
    client.on('notification', message => {
      if (this.client === client) this.notified(message.payload)
    })
    client.on('error', error => {
      this.lost(client, String(error))
    })
    client.on('end', () => {
      this.lost(client, 'the connection ended')
    })
    try {
      await client.connect()
      await client.query(`listen ${CHAT_CHANGES_CHANNEL}`)
    } catch (error) {
      this.lost(client, String(error))
    }
  }

  /**
   * The `LISTEN` connection failed or went. Hints sent meanwhile were never
   * heard, and a `members` hint among them would have dropped a set, so
   * every set goes, every chat socket is told to resync, and it listens
   * again.
   */
  private lost(client: Client, why: string): void {
    if (this.client !== client || this.closed) return
    this.client = undefined
    this.log(`lost the ${CHAT_CHANGES_CHANNEL} listener: ${why}`)
    this.hangUp(client)
    this.members.clear()
    for (const userId of [...this.subscribers.keys()])
      this.sendTo(userId, { type: 'resync' })
    this.retry = setTimeout(() => {
      this.listen().catch(() => undefined)
    }, this.retryMs)
  }
}
