import { asObject, asValue } from 'cleaners'

import {
  makeScoreboardClient,
  makeScoreboardSubscriber,
  quit,
  type ScoreboardClient
} from '../scoreboard/scoreboardStore'
import type {
  ChangeFeed,
  FeedChannel,
  FeedHandlers,
  FeedSubscription
} from './feed'
import { FeedSubscribers } from './feedSubscribers'

/** Where a channel's notices are published. */
export const feedChannelKey = (prefix: string, channel: string): string =>
  `${prefix}:feed:${channel}`

/** Where the relay says it took over, and that it is still there. */
export const feedControlKey = (prefix: string): string =>
  `${prefix}:feed:control`

/** Who leads the relay. */
export const feedLeaderKey = (prefix: string): string => `${prefix}:feed:leader`

const asControlMessage = asObject({
  kind: asValue('resync', 'heartbeat')
})

export interface ValkeyFeedOptions {
  /** Valkey's address and the certificate authority to check it against. */
  url: string
  caFile?: string
  prefix: string
  /** A silence longer than this, with the heartbeat then resuming, is a gap. */
  silenceMs?: number
  /** How long a first publish waits for its connection. */
  connectWaitMs?: number
  log: (message: string) => void
}

/**
 * One subscriber connection for the process, on `<prefix>:feed:<channel>`,
 * opened at the first subscription, and one more client for publishing, opened
 * at the first publish. The elected relay carries what Postgres announces onto
 * these channels, at most once, so everything rests on telling a handler when
 * it may have missed something.
 *
 * Three things are such a gap, and each makes every handler hear
 * `onListening(false)` once: this connection returning, the relay saying it
 * took over, and its heartbeat resuming after a silence. A first attempt that
 * fails counts too, as it does on the Postgres feed.
 */
export class ValkeyFeed implements ChangeFeed {
  private readonly prefix: string
  private readonly silenceMs: number
  private readonly connectWaitMs: number
  private readonly log: (message: string) => void
  private readonly publisher: ScoreboardClient
  private readonly subscriber: ScoreboardClient
  private readonly subscribers: FeedSubscribers
  /** One function per channel for every connection: node-redis keeps a set of listeners. */
  private readonly listeners = new Map<FeedChannel, (message: string) => void>()
  private readonly controlListener = (message: string): void => {
    this.controlled(message)
  }

  /** Counts connections, so a subscription answered on an old one is ignored. */
  private session = 0
  private opened = false
  /** The last the connection was heard of, it had failed. */
  private down = false
  private publisherConnecting: Promise<void> | undefined
  private heardRelayAt: number | undefined
  private closed = false

  constructor(options: ValkeyFeedOptions) {
    this.prefix = options.prefix
    this.silenceMs = options.silenceMs ?? 5000
    this.connectWaitMs = options.connectWaitMs ?? 2000
    this.log = options.log
    this.subscribers = new FeedSubscribers(options.log)
    this.publisher = makeScoreboardClient(
      options.url,
      this.log,
      'feed publisher',
      options.caFile
    )
    this.subscriber = makeScoreboardSubscriber(
      this.publisher,
      this.log,
      'feed subscriber'
    )
    this.subscriber.on('error', () => {
      this.lost()
    })
    this.subscriber.on('ready', () => {
      this.returned()
    })
  }

  subscribe(channel: FeedChannel, handlers: FeedHandlers): FeedSubscription {
    const { subscription, added } = this.subscribers.add(channel, handlers)
    if (this.closed) return subscription
    if (added && this.subscriber.isReady) this.place(channel)
    this.open()
    return subscription
  }

  /** `PUBLISH`, straight to Valkey: this leaves Postgres out of it. */
  async publishEphemeral(channel: FeedChannel, payload: string): Promise<void> {
    await this.publisherReady()
    await this.publisher.publish(feedChannelKey(this.prefix, channel), payload)
  }

  /** The relay's leader as its key names it, or null when nothing leads. */
  async leader(): Promise<string | null> {
    await this.publisherReady()
    return await this.publisher.get(feedLeaderKey(this.prefix))
  }

  async close(): Promise<void> {
    this.closed = true
    this.subscribers.close()
    await Promise.all([quit(this.subscriber), quit(this.publisher)])
  }

  private open(): void {
    if (this.opened) return
    this.opened = true
    this.subscriber.connect().catch((error: unknown) => {
      this.log(`feed subscriber: ${String(error)}`)
    })
  }

  /** Connects on first use, and waits only so long for it. */
  private async publisherReady(): Promise<void> {
    this.publisherConnecting ??= this.publisher.connect().then(
      () => undefined,
      (error: unknown) => {
        this.log(`feed publisher: ${String(error)}`)
      }
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.publisherConnecting,
      new Promise(resolve => {
        timer = setTimeout(resolve, this.connectWaitMs)
      })
    ])
    clearTimeout(timer)
  }

  /** The connection went: every channel has stopped hearing. */
  private lost(): void {
    if (this.closed || this.down || this.subscriber.isReady) return
    this.down = true
    this.heardRelayAt = undefined
    this.subscribers.lost()
  }

  /** Subscribing again is harmless for what node-redis restored itself. */
  private returned(): void {
    this.down = false
    this.session += 1
    this.subscriber
      .subscribe(feedControlKey(this.prefix), this.controlListener)
      .catch(() => undefined)
    for (const channel of this.subscribers.known()) this.place(channel)
  }

  private place(channel: FeedChannel): void {
    const session = this.session
    let listener = this.listeners.get(channel)
    if (listener == null) {
      listener = message => {
        this.subscribers.notified(channel, message)
      }
      this.listeners.set(channel, listener)
    }
    this.subscriber
      .subscribe(feedChannelKey(this.prefix, channel), listener)
      .then(
        () => {
          // Lost on the way, so its handlers wait for the next connection.
          if (this.closed || session !== this.session || this.down) return
          this.subscribers.placed(channel)
        },
        () => undefined
      )
  }

  /** A word from the relay. */
  private controlled(message: string): void {
    let kind: string
    try {
      kind = asControlMessage(JSON.parse(message)).kind
    } catch (error) {
      this.log(`an unreadable control message: ${String(error)}`)
      return
    }
    const now = Date.now()
    const silent =
      this.heardRelayAt != null && now - this.heardRelayAt >= this.silenceMs
    this.heardRelayAt = now
    if (kind === 'resync' || silent) this.subscribers.gap()
  }
}
