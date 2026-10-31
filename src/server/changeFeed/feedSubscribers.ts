import type { FeedChannel, FeedHandlers, FeedSubscription } from './feed'

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
  /** The transport holds this channel on its present connection. */
  inPlace: boolean
  subscribers: Set<Subscriber>
}

/**
 * Who hears what, and what each has been told, whichever way the notices come.
 * It holds what every feed promises: a handler hears `onListening(true)` when
 * its channel is first in place, `onListening(false)` once after a gap however
 * long the gap, and every payload of its channel, and `listening` settles when
 * the channel is in place or its first attempt has failed. A feed tells it what
 * happened to its transport, and does nothing about handlers itself.
 */
export class FeedSubscribers {
  private readonly channels = new Map<FeedChannel, ChannelState>()
  private readonly log: (message: string) => void
  private closed = false

  constructor(log: (message: string) => void) {
    this.log = log
  }

  /** Adds a handler. `added` says its channel is new, and the transport must place it. */
  add(
    channel: FeedChannel,
    handlers: FeedHandlers
  ): { subscription: FeedSubscription; added: boolean; inPlace: boolean } {
    let settle: () => void = () => undefined
    const listening = new Promise<void>(resolve => {
      settle = resolve
    })
    if (this.closed) {
      settle()
      return {
        subscription: { listening, stop: () => undefined },
        added: false,
        inPlace: false
      }
    }
    const subscriber: Subscriber = { handlers, owed: true, gap: false, settle }
    let state = this.channels.get(channel)
    const added = state == null
    if (state == null) {
      state = { inPlace: false, subscribers: new Set() }
      this.channels.set(channel, state)
    }
    const joined = state
    joined.subscribers.add(subscriber)
    if (joined.inPlace) {
      // After the caller has its subscription, as when it has to wait.
      queueMicrotask(() => {
        this.tell(subscriber)
      })
    }
    return {
      subscription: {
        listening,
        stop: () => {
          joined.subscribers.delete(subscriber)
          subscriber.owed = false
          settle()
        }
      },
      added,
      inPlace: joined.inPlace
    }
  }

  /** Every channel anyone has asked for, for a transport to place again. */
  known(): FeedChannel[] {
    return [...this.channels.keys()]
  }

  /** The transport holds this channel now: its handlers hear what they are owed. */
  placed(channel: FeedChannel): void {
    const state = this.channels.get(channel)
    if (state == null) return
    state.inPlace = true
    for (const subscriber of [...state.subscribers]) this.tell(subscriber)
  }

  /** The transport went: every channel has stopped hearing, until placed again. */
  lost(): void {
    for (const state of this.channels.values()) {
      state.inPlace = false
      for (const subscriber of state.subscribers) {
        subscriber.owed = true
        subscriber.gap = true
        subscriber.settle()
      }
    }
  }

  /** Notices may have gone unheard while the channels stayed in place. */
  gap(): void {
    for (const state of this.channels.values())
      for (const subscriber of [...state.subscribers]) {
        subscriber.owed = true
        subscriber.gap = true
        if (state.inPlace) this.tell(subscriber)
      }
  }

  /** A payload, to every handler of its channel. */
  notified(channel: FeedChannel, payload: string | undefined): void {
    const state = this.channels.get(channel)
    if (state == null) return
    for (const subscriber of [...state.subscribers])
      this.safely(() => {
        subscriber.handlers.onPayload(payload)
      })
  }

  /** Lets every handler go. Whoever subscribes after this hears nothing. */
  close(): void {
    this.closed = true
    for (const state of this.channels.values())
      for (const subscriber of state.subscribers) subscriber.settle()
    this.channels.clear()
  }

  private tell(subscriber: Subscriber): void {
    if (!subscriber.owed) return
    subscriber.owed = false
    const first = !subscriber.gap
    subscriber.gap = false
    this.safely(() => subscriber.handlers.onListening?.(first))
    subscriber.settle()
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
