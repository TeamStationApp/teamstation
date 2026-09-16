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
  /** Where stills are cached, under the media root as `work`. */
  workDir: string
  /** The pinned build, used for the one frame a still needs. */
  ffmpegPath: string
  /** Signs the `/media` tokens. The same key the proxy's auth check uses. */
  mediaSecret: string
  /** The origin URLs are built against, e.g. `https://tube2.gamestation.co`. */
  publicUrl: string
  /** The bucket finished videos live in. Empty until one is configured. */
  space: SpaceSettings
}
