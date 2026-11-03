import { presignGetUrl, type ReadOnlySpaceSource } from './presign'

/**
 * Serving a video that lives in the Space.
 *
 * The API serves playlists and signs their media objects. Players read live
 * fragments or byte ranges of a finished MP4 directly from the Space.
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
  readOnlySource?: ReadOnlySpaceSource
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
 * Rewrites media and init-map URIs, retaining durations, ranges and tags.
 * The string overload keeps existing single-file callers working.
 */
export function rewriteMediaPlaylist(
  body: string,
  videoFile: string | ((uri: string) => string),
  presignedUrl?: string
): string {
  const sign =
    typeof videoFile === 'function'
      ? videoFile
      : (uri: string): string => (uri === videoFile ? presignedUrl! : uri)
  return body
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (trimmed !== '' && !trimmed.startsWith('#')) return sign(trimmed)
      if (trimmed.startsWith('#EXT-X-MAP:')) {
        return line.replace(
          /URI="([^"]+)"/,
          (_match, uri: string) => `URI="${sign(uri)}"`
        )
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
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const body = await response.text()
    this.cache.set(key, body)
    return body
  }
}

/** The single variant written by either recording pipeline. */
export function mediaVariant(
  body: string
): 'index.m3u8' | 'video.m3u8' | undefined {
  const variants = body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  if (variants.length !== 1) return undefined
  const variant = variants[0]
  return variant === 'index.m3u8' || variant === 'video.m3u8'
    ? variant
    : undefined
}

const SIGNING_WINDOW_MS = 15 * 60_000

/** Shared by the viewers on one API worker, including their in-flight reads. */
export class SpacePlayback {
  readonly playlists: PlaylistCache
  private window = -1
  private readonly signed = new Map<string, string>()
  private readonly open = new Map<
    string,
    { at: number; body: Promise<string | undefined> }
  >()

  private readonly rewritten = new Map<
    string,
    { body: string; window: number; result: string }
  >()

  constructor(
    private readonly source: PlaylistSource,
    private readonly now: () => number = Date.now
  ) {
    this.playlists = new PlaylistCache(source)
  }

  sign(videoId: string, uri: string): string {
    // Objects must remain inside this video's prefix, including init maps.
    if (!/^(?:video\.mp4|init(?:\d{6,})?\.mp4|seg\d{6,}\.m4s)$/.test(uri))
      throw new Error('Invalid media object URI')
    const window =
      Math.floor(this.now() / SIGNING_WINDOW_MS) * SIGNING_WINDOW_MS
    if (window !== this.window) {
      this.signed.clear()
      this.rewritten.clear()
      this.window = window
    }
    const key = spaceKey(videoId, uri)
    let url = this.signed.get(key)
    if (url == null) {
      url = presignGetUrl({
        ...this.source.space,
        key,
        now: new Date(window),
        expiresSec: this.source.expiresSec + SIGNING_WINDOW_MS / 1000
      })
      this.signed.set(key, url)
    }
    return url
  }

  async get(
    videoId: string,
    file: string,
    verified: boolean
  ): Promise<string | undefined> {
    if (file !== 'index.m3u8' || verified)
      return await this.playlists.get(videoId, file)
    const at = this.now()
    const held = this.open.get(videoId)
    if (held != null && at - held.at < 1000) return await held.body
    // An unresolved request stays shared even if the store takes over a second.
    const pending = { at: Infinity, body: this.readOpen(videoId) }
    this.open.set(videoId, pending)
    try {
      return await pending.body
    } finally {
      pending.at = this.now()
      // Bound retention of idle live entries without an additional timer.
      for (const [id, entry] of this.open) {
        if (this.now() - entry.at > 60_000) this.open.delete(id)
      }
    }
  }

  rewrite(videoId: string, file: string, body: string): string {
    // Rotate the signature window before consulting the rewritten body.
    this.sign(videoId, 'init.mp4')
    const key = spaceKey(videoId, file)
    const held = this.rewritten.get(key)
    if (held?.body === body && held.window === this.window) return held.result
    const result = rewriteMediaPlaylist(body, uri => this.sign(videoId, uri))
    this.rewritten.set(key, { body, window: this.window, result })
    return result
  }

  private async readOpen(videoId: string): Promise<string | undefined> {
    const response = await (this.source.fetch ?? globalThis.fetch)(
      presignGetUrl({
        ...this.source.space,
        key: spaceKey(videoId, 'index.m3u8'),
        expiresSec: this.source.expiresSec
      })
    )
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    return await response.text()
  }
}
