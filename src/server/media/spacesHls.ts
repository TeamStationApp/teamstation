import { presignGetUrl } from './presign'

/**
 * Serving a video that lives in the Space.
 *
 * The API serves the two playlists — they are a few KB — and rewrites the one
 * media entry in them to a **presigned URL** for the Space. The player then
 * range-requests `video.mp4` straight from the Space, so the video bytes never
 * pass through the droplet. That is the whole reason the remux writes a single
 * file: one object needs one signature, however long the game is.
 */

export interface SpaceSettings {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /**
   * Put the bucket in the path rather than the host. Spaces wants it in the
   * host; a stand-in running on localhost has no wildcard DNS and needs this.
   */
  pathStyle?: boolean
}

/** Whether a Space is configured at all. Nothing is attempted without a key. */
export function spaceConfigured(space: SpaceSettings): boolean {
  return (
    space.bucket !== '' &&
    space.accessKeyId !== '' &&
    space.secretAccessKey !== ''
  )
}

export function spaceKey(videoId: string, file: string): string {
  return `videos/${videoId}/${file}`
}

/**
 * Points the master playlist's variant at this API rather than at a relative
 * name, so the token survives the hop. A `<video>` element drops the query
 * string when it resolves a relative URI, which would make the second request
 * unauthenticated.
 */
export function rewriteMasterPlaylist(
  body: string,
  variantUrl: string
): string {
  return body
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) return line
      // The only non-comment line in a master playlist is the variant's URI.
      return variantUrl
    })
    .join('\n')
}

/**
 * Replaces every reference to the video file with its presigned URL, in the
 * `EXT-X-MAP` and in each byte-range entry alike. Everything else — the
 * durations, the ranges, the tags — is left exactly as the muxer wrote it.
 */
export function rewriteMediaPlaylist(
  body: string,
  videoFile: string,
  presignedUrl: string
): string {
  return body
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (trimmed === videoFile) return presignedUrl
      if (trimmed.startsWith('#EXT-X-MAP:')) {
        return line.replace(`URI="${videoFile}"`, `URI="${presignedUrl}"`)
      }
      return line
    })
    .join('\n')
}

export interface PlaylistSource {
  /** Swapped out in tests. */
  fetch?: typeof fetch
  space: SpaceSettings
  /** How long a presigned URL lasts. */
  expiresSec: number
}

/**
 * Fetches a playlist out of the Space, once.
 *
 * VOD playlists never change, so a worker keeps them; they are a few KB each
 * and a game has two. The cache is per worker, which is fine: the cost of a
 * miss is one small GET.
 */
export class PlaylistCache {
  private readonly cache = new Map<string, string>()
  private readonly source: PlaylistSource

  constructor(source: PlaylistSource) {
    this.source = source
  }

  clear(): void {
    this.cache.clear()
  }

  async get(videoId: string, file: string): Promise<string | undefined> {
    const key = spaceKey(videoId, file)
    const held = this.cache.get(key)
    if (held != null) return held

    const { space, expiresSec } = this.source
    const doFetch = this.source.fetch ?? globalThis.fetch
    const url = presignGetUrl({ ...space, key, expiresSec })

    const response = await doFetch(url)
    if (!response.ok) return undefined
    const body = await response.text()
    this.cache.set(key, body)
    return body
  }
}
