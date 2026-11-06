import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/** Every channel the server's writers notify and its processes hear. */
export type FeedChannel =
  | 'game_changes'
  | 'screen_scopes'
  | 'chat_changes'
  | 'chat_dirty'
  | 'game_stats'
  | 'feed_probe'

/** The same, for what has to hear them all. */
export const FEED_CHANNELS: readonly FeedChannel[] = [
  'game_changes',
  'screen_scopes',
  'chat_changes',
  'chat_dirty',
  'game_stats',
  'feed_probe'
]

export interface FeedHandlers {
  onPayload: (payload: string | undefined) => void
  /** The channel is in place. `first` is false after a gap, when notices may have gone unheard. */
  onListening?: (first: boolean) => void
}

export interface FeedSubscription {
  /** Settles once the channel is first in place, or that first attempt has failed. */
  listening: Promise<void>
  /** Lets go of this handler alone. */
  stop: () => void
}

/**
 * How one process hears the server's notices. Each process holds one, whatever
 * it subscribes to, so its connections do not grow with its channels.
 * Consumers keep their own coalescing and ordering.
 */
export interface ChangeFeed {
  subscribe: (channel: FeedChannel, handlers: FeedHandlers) => FeedSubscription
  /** A notice nothing persists: not tied to a commit. */
  publishEphemeral: (
    channel: FeedChannel,
    payload: string,
    db: Kysely<Database>
  ) => Promise<void>
  close: () => Promise<void>
}
