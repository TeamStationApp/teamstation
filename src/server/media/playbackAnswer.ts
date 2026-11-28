import type { VideosTable } from '../db/database'
import { locateVideo } from './locations'
import {
  MEDIA_TOKEN_TTL_SEC,
  mediaUrlPath,
  signQueryToken
} from './mediaTokens'
import {
  mediaVariant,
  type PlaylistCache,
  spaceConfigured,
  type SpaceSettings
} from './spacesHls'

/** What a playback answer is built from: where the files are, and the keys. */
export interface PlaybackDeps {
  mediaRoot: string
  space: SpaceSettings
  /** Reads a video's master playlist from the Space. */
  playlists: PlaylistCache
  publicUrl: string
  mediaSecret: string
}

/** What the answer reads of a video's row. */
export interface PlaybackVideo {
  id: string
  storage: VideosTable['storage']
  kind: VideosTable['kind']
  durationSec: number | null
  spaceSecret: string | null
  /**
   * The recording's sample-entry tag (`videos.codecs`: `hvc1`, `avc1`), or
   * null where none is stored. Required, so every query that builds one
   * selects it: the players ask this browser about the codec it names.
   */
  codecs: string | null
}

/** `GET /videos/:videoId/playback`'s answer. */
export interface PlaybackAnswer {
  videoId: string
  storage: VideosTable['storage']
  url: string | null
  expiresAt: string | null
  durationSec: number | null
  unavailable: boolean
  pending?: boolean
  /** The video's `codecs`, for the player to ask this browser about. */
  codecs: string | null
}

/** What an HLS token is signed against: this video's playlists, and no other. */
export function hlsSubject(videoId: string): string {
  return `hls:${videoId}`
}

/**
 * Where a player plays `video`, for somebody already let in: the API's own
 * playlists for a video in the Space (the permission in the query, since a
 * `<video>` element cannot send a bearer token), or the signed `/media` path
 * of a local one, good for `MEDIA_TOKEN_TTL_SEC` from `now`. A video whose
 * files are not there answers `unavailable`, and a live one still waiting
 * for its first publication to the Space answers `pending` too.
 */
export async function playbackAnswer(
  deps: PlaybackDeps,
  video: PlaybackVideo,
  now: number
): Promise<PlaybackAnswer> {
  const { mediaRoot, space, playlists, publicUrl, mediaSecret } = deps
  const videoId = video.id
  const waitingForOrigin =
    video.storage === 'local' && video.kind === 'live' && spaceConfigured(space)
  const location = waitingForOrigin
    ? undefined
    : await locateVideo({
        mediaRoot,
        storage: video.storage,
        videoId,
        spaceSecret: video.spaceSecret
      })
  if (location == null) {
    // The row says there is a video; its files are not there. Better to
    // say so than to hand back a URL that plays black.
    return {
      videoId,
      storage: video.storage,
      url: null,
      expiresAt: null,
      durationSec: video.durationSec,
      unavailable: true,
      codecs: video.codecs,
      // Finish may race the first acknowledgement. No node should issue
      // a scratch URL that the pending origin close will immediately remove.
      pending: waitingForOrigin
    }
  }

  let entry = 'master.m3u8'
  if (video.storage === 'spaces' && video.kind === 'live') {
    const master = await playlists.get(
      { id: videoId, spaceSecret: video.spaceSecret },
      'master.m3u8'
    )
    if (master != null && mediaVariant(master) === 'index.m3u8')
      entry = 'index.m3u8'
  }
  const url =
    video.storage === 'spaces'
      ? // The API serves these playlists itself, pointing each media entry
        // at the Space (unsigned under the video's secret path, presigned
        // without one) so the bytes come from the Space directly. A
        // `<video>` element cannot send a bearer token, so the permission
        // rides in the query string.
        `${publicUrl}/api/v1/videos/${videoId}/hls/${entry}?t=${signQueryToken(
          mediaSecret,
          hlsSubject(videoId),
          now
        )}`
      : publicUrl +
        mediaUrlPath(mediaSecret, location.dir, location.master, now)

  return {
    videoId,
    storage: video.storage,
    url,
    expiresAt: new Date(now + MEDIA_TOKEN_TTL_SEC * 1000).toISOString(),
    durationSec: video.durationSec,
    unavailable: false,
    codecs: video.codecs
  }
}
