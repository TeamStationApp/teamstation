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
  /** The subscription holds on the present connection. */
  inPlace: boolean
  subscribers: Set<Subscriber>
  listener: (message: string) => void
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
  private readonly channels = new Map<FeedChannel, ChannelState>()
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
    const added = state == null
    if (state == null) {
      state = {
        inPlace: false,
        subscribers: new Set(),
        listener: message => {
          this.notified(channel, message)
        }
      }
      this.channels.set(channel, state)
    }
    const joined = state
    joined.subscribers.add(subscriber)
    if (joined.inPlace) {
      // After the caller has its subscription, as when it has to wait.
      queueMicrotask(() => {
        this.tell(subscriber)
      })
    } else if (added && this.subscriber.isReady) {
      this.place(channel, joined)
    }
    this.open()
    return {
      listening,
      stop: () => {
        joined.subscribers.delete(subscriber)
        subscriber.owed = false
        settle()
      }
    }
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
    for (const state of this.channels.values())
      for (const subscriber of state.subscribers) subscriber.settle()
    this.channels.clear()
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
    for (const state of this.channels.values()) {
      state.inPlace = false
      for (const subscriber of state.subscribers) {
        subscriber.owed = true
        subscriber.gap = true
        subscriber.settle()
      }
    }
  }

  /** Subscribing again is harmless for what node-redis restored itself. */
  private returned(): void {
    this.down = false
    this.session += 1
    this.subscriber
      .subscribe(feedControlKey(this.prefix), message => {
        this.controlled(message)
      })
      .catch(() => undefined)
    for (const [channel, state] of this.channels) this.place(channel, state)
  }

  private place(channel: FeedChannel, state: ChannelState): void {
    const session = this.session
    this.subscriber
      .subscribe(feedChannelKey(this.prefix, channel), state.listener)
      .then(
        () => {
          // Lost on the way, so its handlers wait for the next connection.
          if (this.closed || session !== this.session || this.down) return
          state.inPlace = true
          for (const subscriber of [...state.subscribers]) this.tell(subscriber)
        },
        () => undefined
      )
  }

  private tell(subscriber: Subscriber): void {
    if (!subscriber.owed) return
    subscriber.owed = false
    const first = !subscriber.gap
    subscriber.gap = false
    this.safely(() => subscriber.handlers.onListening?.(first))
    subscriber.settle()
  }

  private notified(channel: FeedChannel, payload: string): void {
    const state = this.channels.get(channel)
    if (state == null) return
    for (const subscriber of [...state.subscribers])
      this.safely(() => {
        subscriber.handlers.onPayload(payload)
      })
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
    if (kind === 'resync' || silent) this.gap()
  }

  /** Notices may have gone unheard while the channels stayed in place. */
  private gap(): void {
    for (const state of this.channels.values())
      for (const subscriber of [...state.subscribers]) {
        subscriber.owed = true
        subscriber.gap = true
        if (state.inPlace) this.tell(subscriber)
      }
  }

  /** One handler's failure is neither the feed's nor the other handlers'. */
  private safely(act: () => void): void {
    try {
      act()
    } catch (error) {
      this.log(`a handler failed: ${String(error)}`)
    }
  }
}
