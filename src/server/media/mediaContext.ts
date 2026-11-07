import type { ChangeFeed } from '../changeFeed/feed'
import type { LivePlaylistClients } from './livePlaylists'
import type { SpaceSettings } from './spacesHls'

/**
 * What a route needs in order to hand out media: where the files are, the key
 * that signs access to them, and the build that takes a still.
 *
 * Shared rather than duplicated, because the playback URL in one route and the
 * still URL in another have to be signed by the same key to be worth anything.
 */
export interface MediaContext {
  /** the media root. */
  mediaRoot: string
  /** The pinned build, used for the one frame a still needs. */
  ffmpegPath: string
  /** Signs the `/media` tokens. The same key the proxy's auth check uses. */
  mediaSecret: string
  /** The origin URLs are built against, e.g. `https://app.teamstation.app`. */
  publicUrl: string
  /** The bucket finished videos and their stills live in. */
  space: SpaceSettings
  /**
   * The worker's change feed, once it has one. The routes are mounted before
   * the feed is made, so this is filled later; until then nothing that needs
   * its notices is cached.
   */
  liveFeed?: FeedHolder
  /** The Valkey connections live playlists are followed through. */
  livePlaylists?: LivePlaylistClients
}

/** A change feed that is made after the code that needs it. */
export class FeedHolder {
  private feed?: ChangeFeed
  private readonly waiting: Array<(feed: ChangeFeed) => void> = []

  get filled(): boolean {
    return this.feed != null
  }

  fill(feed: ChangeFeed): void {
    if (this.feed != null) throw new Error('The feed holder is already filled')
    this.feed = feed
    for (const take of this.waiting.splice(0)) take(feed)
  }

  /** Runs once the feed exists: at once, if it already does. */
  onFill(take: (feed: ChangeFeed) => void): void {
    if (this.feed != null) take(this.feed)
    else this.waiting.push(take)
  }
}
