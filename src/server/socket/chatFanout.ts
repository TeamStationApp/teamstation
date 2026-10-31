import { asEither, asNumber, asObject, asOptional, asString } from 'cleaners'
import { type Kysely, sql } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import type { ChatSocketFrame } from '../../common/gameSocket'
import { asUserId } from '../../common/userId'
import type { ChangeFeed } from '../changeFeed/feed'
import { CHAT_CHANGES_CHANNEL } from '../chat/membershipLog'
import { type Database, isPoolTimeout } from '../db/database'

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
  /** The process's feed, on the same database as `db`. */
  feed: ChangeFeed
  /** How long to wait before trying an owed `resync` again. */
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
 * with nothing to subscribe to. It hears `chat_changes` on the worker's feed.
 * A conversation's hint goes to the sockets of its current members, read
 * once per conversation and cached until a `members` hint for it (or a gap
 * in the feed) drops the set; a `typing` hint goes to every member but the
 * typist; a user's hint goes to that user's sockets. Nothing of a message is
 * sent, only that something changed: clients fetch it over REST.
 *
 * Like `GameFanout`, it acts once the feed returns after a gap. Hints sent
 * meanwhile were never heard, so every chat socket on the worker is told to
 * `resync`.
 *
 * A hint whose member set cannot be read for want of a connection cannot be
 * sent, and who to tell is exactly what could not be read. So the read is
 * tried again every `retryMs`, once per conversation, and when it succeeds
 * that conversation's members are told to `resync`.
 */
export class ChatFanout {
  /** Settles once the channel is first in place, or that attempt has failed. */
  readonly listening: Promise<void>
  private readonly db: Kysely<Database>
  private readonly retryMs: number
  private readonly cacheSize: number
  private readonly readMembers: MemberReader
  private readonly now: () => Date
  private readonly log: (message: string) => void
  /** The sockets on this worker, by user id. */
  private readonly subscribers = new Map<string, Set<ChatSubscriber>>()
  /** Member sets by conversation, oldest first. */
  private readonly members = new Map<string, Promise<Set<string>>>()
  /** Conversations whose members are owed a `resync`, with its next try. */
  private readonly owed = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly stopListening: () => void
  private closed = false

  constructor(options: ChatFanoutOptions) {
    this.db = options.db
    this.retryMs = options.retryMs ?? 1000
    this.cacheSize = options.cacheSize ?? 1000
    this.readMembers = options.readMembers ?? readMembers
    this.now = options.now ?? (() => new Date())
    this.log =
      options.log ??
      (message => {
        console.error(`chat socket: ${message}`)
      })
    const subscription = options.feed.subscribe(CHAT_CHANGES_CHANNEL, {
      onPayload: payload => {
        this.notified(payload)
      },
      onListening: first => {
        if (!first) this.returned()
      }
    })
    this.listening = subscription.listening
    this.stopListening = subscription.stop
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
    this.stopListening()
    for (const timer of this.owed.values()) clearTimeout(timer)
    this.owed.clear()
    this.subscribers.clear()
    this.members.clear()
  }

  /** A notify, as the feed hands it over. */
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
    let members: Set<string>
    try {
      members = await this.membersOf(change.c)
    } catch (error) {
      if (!isPoolTimeout(error)) throw error
      // A typing hint is over by the time anyone could hear it: nothing to
      // read again.
      if (change.k !== 'typing') this.oweResync(change.c)
      return
    }
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

  /** Tries again shortly to tell a conversation's members to read again. */
  private oweResync(conversationId: string): void {
    if (this.closed || this.owed.has(conversationId)) return
    this.log(`owing ${conversationId} a resync: no database connection in time`)
    this.owed.set(
      conversationId,
      setTimeout(() => {
        this.owed.delete(conversationId)
        this.payResync(conversationId).catch((error: unknown) => {
          this.log(`resyncing ${conversationId}: ${String(error)}`)
        })
      }, this.retryMs)
    )
  }

  private async payResync(conversationId: string): Promise<void> {
    let members: Set<string>
    try {
      members = await this.membersOf(conversationId)
    } catch (error) {
      if (!isPoolTimeout(error)) throw error
      this.oweResync(conversationId)
      return
    }
    for (const userId of members) this.sendTo(userId, { type: 'resync' })
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

  /**
   * The feed has returned after a gap. Hints sent meanwhile were never heard,
   * and a `members` hint among them would have dropped a set, so every set
   * goes and every chat socket is told to resync.
   */
  private returned(): void {
    this.members.clear()
    for (const userId of [...this.subscribers.keys()])
      this.sendTo(userId, { type: 'resync' })
  }
}
