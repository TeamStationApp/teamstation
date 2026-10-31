import { type Kysely, sql } from 'kysely'
import { Client } from 'pg'

import type { Database } from '../db/database'
import type {
  ChangeFeed,
  FeedChannel,
  FeedHandlers,
  FeedSubscription
} from './feed'

/** How a feed's connection shows in `pg_stat_activity`. */
export const FEED_APPLICATION_NAME = 'teamstation-feed'

export interface PostgresFeedOptions {
  /** The database's own address, never a transaction-mode pool, where `LISTEN` does not work. */
  databaseUrl: string
  /** How long to wait before connecting again after the connection is lost. */
  retryMs?: number
  log: (message: string) => void
}

/** One handler on one channel. */
interface Subscriber {
  handlers: FeedHandlers
  /** Waiting to hear that its channel is in place. */
  owed: boolean
  /** Its channel went unheard since it last heard that. */
  gap: boolean
  settle: () => void
}

interface ChannelState {
  /** A `LISTEN` holds on the present connection. */
  inPlace: boolean
  subscribers: Set<Subscriber>
}

/**
 * One direct connection for the process, with one `LISTEN` per channel it has
 * subscribed to, opened at the first subscription.
 *
 * The connection failing or ending takes every channel with it. It connects
 * again after `retryMs`, and each handler then hears `onListening(false)` once,
 * however many attempts that took, since notices in between went unheard. A
 * first attempt that fails counts as such a gap. A channel stays listened to
 * once its handlers have gone, until the feed closes.
 */
export class PostgresFeed implements ChangeFeed {
  private readonly databaseUrl: string
  private readonly retryMs: number
  private readonly log: (message: string) => void
  private readonly channels = new Map<FeedChannel, ChannelState>()
  private client: Client | undefined
  /** `client` has connected, so a new channel can listen on it at once. */
  private connected = false
  /** The `LISTEN`s under way, since a connection runs one query at a time. */
  private placing: Promise<void> = Promise.resolve()
  /** Lost connections still hanging up, which close() waits for too. */
  private readonly hangingUp = new Set<Promise<void>>()
  private retry: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(options: PostgresFeedOptions) {
    this.databaseUrl = options.databaseUrl
    this.retryMs = options.retryMs ?? 1000
    this.log = options.log
  }

  subscribe(channel: FeedChannel, handlers: FeedHandlers): FeedSubscription {
    let settle: () => void = () => undefined
    const listening = new Promise<void>(resolve => {
      settle = resolve
    })
    if (this.closed) {
      settle()
      return { listening, stop: () => undefined }
    }
    const subscriber: Subscriber = { handlers, owed: true, gap: false, settle }
    let state = this.channels.get(channel)
    if (state == null) {
      state = { inPlace: false, subscribers: new Set() }
      this.channels.set(channel, state)
      if (this.client != null && this.connected)
        this.place(this.client, channel, state)
    }
    const joined = state
    joined.subscribers.add(subscriber)
    if (joined.inPlace) {
      // After the caller has its subscription, as when it has to wait.
      queueMicrotask(() => {
        this.tell(subscriber)
      })
    } else if (this.client == null && this.retry == null) {
      this.connect().catch(() => undefined)
    }
    return {
      listening,
      stop: () => {
        joined.subscribers.delete(subscriber)
        subscriber.owed = false
        settle()
      }
    }
  }

  async publishEphemeral(
    channel: FeedChannel,
    payload: string,
    db: Kysely<Database>
  ): Promise<void> {
    await sql`select pg_notify(${channel}, ${payload})`.execute(db)
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retry)
    for (const state of this.channels.values())
      for (const subscriber of state.subscribers) subscriber.settle()
    this.channels.clear()
    const client = this.client
    this.client = undefined
    if (client != null) this.hangUp(client)
    await Promise.all([...this.hangingUp])
  }

  private async connect(): Promise<void> {
    const client = new Client({
      connectionString: this.databaseUrl,
      application_name: FEED_APPLICATION_NAME
    })
    this.client = client
    client.on('notification', message => {
      if (this.client === client)
        this.notified(message.channel as FeedChannel, message.payload)
    })
    client.on('error', error => {
      this.lost(client, String(error))
    })
    client.on('end', () => {
      this.lost(client, 'the connection ended')
    })
    try {
      await client.connect()
    } catch (error) {
      this.lost(client, String(error))
      return
    }
    if (this.client !== client) return
    this.connected = true
    for (const [channel, state] of this.channels)
      this.place(client, channel, state)
  }

  /**
   * Listens on one channel, after any before it, and tells its handlers once
   * that holds.
   */
  private place(
    client: Client,
    channel: FeedChannel,
    state: ChannelState
  ): void {
    this.placing = this.placing.then(async () => {
      if (this.client !== client) return
      try {
        await client.query(`listen ${channel}`)
      } catch (error) {
        this.lost(client, String(error))
        return
      }
      if (this.client !== client) return
      state.inPlace = true
      for (const subscriber of [...state.subscribers]) this.tell(subscriber)
    })
  }

  private tell(subscriber: Subscriber): void {
    if (!subscriber.owed) return
    subscriber.owed = false
    const first = !subscriber.gap
    subscriber.gap = false
    this.safely(() => subscriber.handlers.onListening?.(first))
    subscriber.settle()
  }

  private notified(channel: FeedChannel, payload: string | undefined): void {
    const state = this.channels.get(channel)
    if (state == null) return
    for (const subscriber of [...state.subscribers])
      this.safely(() => {
        subscriber.handlers.onPayload(payload)
      })
  }

  /** One handler's failure is neither the feed's nor the other handlers'. */
  private safely(act: () => void): void {
    try {
      act()
    } catch (error) {
      this.log(`a handler failed: ${String(error)}`)
    }
  }

  /**
   * The connection failed or went: every channel has stopped hearing, and
   * every handler is owed a word when it hears again.
   */
  private lost(client: Client, why: string): void {
    if (this.client !== client || this.closed) return
    this.client = undefined
    this.connected = false
    this.log(`lost the feed connection: ${why}`)
    this.hangUp(client)
    for (const state of this.channels.values()) {
      state.inPlace = false
      for (const subscriber of state.subscribers) {
        subscriber.owed = true
        subscriber.gap = true
        subscriber.settle()
      }
    }
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.connect().catch(() => undefined)
    }, this.retryMs)
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
}
