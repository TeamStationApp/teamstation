import { type LivePlaylistOptions, LivePlaylists } from './livePlaylists'
import {
  isReadOnlySourceKey,
  presignGetUrl,
  type ReadOnlySpaceSource
} from './presign'
import { videoKey, type VideoPath, videoPrefix } from './videoPrefix'

/**
 * Serving a video that lives in the Space.
 *
 * The API serves playlists, which stay private. Their media objects are
 * public under a video's secret path, so a playlist lists them as plain URLs
 * on `mediaBaseUrl` (a CDN); a video on its old path, or an object from the
 * read-only source, is listed with a presigned URL instead. Players read live
 * fragments or byte ranges of a finished MP4 directly from there.
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
  /**
   * Where viewers fetch public media from, for example the CDN endpoint's
   * origin, with or without a path. Empty means the bucket's own base.
   */
  mediaBaseUrl?: string
}

/**
 * The base a public object's URL is built on: `mediaBaseUrl`, or the bucket
 * itself, `https://<bucket>.<host>`, or `<endpoint>/<bucket>` in path style
 * (as `presignGetUrl` builds paths). No trailing slash.
 */
export function mediaBase(space: SpaceSettings): string {
  const configured = space.mediaBaseUrl ?? ''
  if (configured !== '') return configured.replace(/\/+$/, '')
  const endpoint = new URL(space.endpoint)
  return space.pathStyle === true
    ? `${endpoint.protocol}//${endpoint.host}/${space.bucket}`
    : `${endpoint.protocol}//${space.bucket}.${endpoint.host}`
}

/** Whether a Space is configured at all. Nothing is attempted without a key. */
export function spaceConfigured(space: SpaceSettings): boolean {
  return (
    space.bucket !== '' &&
    space.accessKeyId !== '' &&
    space.secretAccessKey !== ''
  )
}

/** One of a video's objects: `videos/<id>-<secret>/<file>`, or its old path. */
export function spaceKey(video: VideoPath, file: string): string {
  return videoKey(video, file)
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
  /** How long a playlist read from the Space may take, body included. */
  timeoutMs?: number
}

/**
 * A Space read that takes longer rejects, as a failed one does. One read of an
 * open playlist is shared by every viewer of the video on a worker, so with no
 * limit one that hung would hold them all.
 */
const SPACE_READ_TIMEOUT_MS = 5000

async function spaceRead(
  source: PlaylistSource,
  url: string
): Promise<Response> {
  return await (source.fetch ?? globalThis.fetch)(url, {
    signal: AbortSignal.timeout(source.timeoutMs ?? SPACE_READ_TIMEOUT_MS)
  })
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

  async get(video: VideoPath, file: string): Promise<string | undefined> {
    const key = spaceKey(video, file)
    const held = this.cache.get(key)
    if (held != null) return held

    const { space, expiresSec } = this.source
    const url = presignGetUrl({ ...space, key, expiresSec })

    const response = await spaceRead(this.source, url)
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

/**
 * Shared by the viewers on one API worker, including their in-flight reads.
 *
 * An open `index.m3u8` comes from Valkey when the worker follows live
 * playlists there (`LivePlaylists`), each line rewritten once; otherwise, or
 * while Valkey cannot give it, from the Space, at most once a second.
 */
export class SpacePlayback {
  readonly playlists: PlaylistCache
  /** The live playlists this worker follows in Valkey, when it does. */
  readonly following?: LivePlaylists
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
    private readonly now: () => number = Date.now,
    live?: LivePlaylistOptions
  ) {
    this.playlists = new PlaylistCache(source)
    if (live != null) this.following = new LivePlaylists({ now, ...live })
  }

  /**
   * An open video's `index.m3u8`, rewritten for a player: from Valkey when it
   * has the list, or from the Space, read at most once a second.
   */
  async live(video: VideoPath): Promise<string | undefined> {
    if (this.following != null) {
      // A signed URL lasts its window: a copy signed in the last is redone.
      const window = this.rotate()
      const epoch = video.spaceSecret == null ? window : 0
      const followed = await this.following.read(
        video,
        text => rewriteMediaPlaylist(text, uri => this.sign(video, uri)),
        epoch
      )
      if (followed != null) return followed
    }
    const body = await this.get(video, 'index.m3u8', false)
    return body == null ? undefined : this.rewrite(video, 'index.m3u8', body)
  }

  /**
   * A media object's URL for a player: a plain URL on `mediaBase` under the
   * video's secret path, with no query string, or a presigned one for a video
   * with no secret and for a read-only-source object, which are not public.
   */
  sign(video: VideoPath, uri: string): string {
    // Objects must remain inside this video's prefix, including init maps.
    if (!/^(?:video\.mp4|init\.mp4|seg\d{6,}\.m4s)$/.test(uri))
      throw new Error('Invalid media object URI')
    const key = spaceKey(video, uri)
    if (
      video.spaceSecret != null &&
      !isReadOnlySourceKey(this.source.space, key)
    )
      return `${mediaBase(this.source.space)}/${key}`
    const window = this.rotate()
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

  /** The current signing window, forgetting what was signed in the last. */
  private rotate(): number {
    const window =
      Math.floor(this.now() / SIGNING_WINDOW_MS) * SIGNING_WINDOW_MS
    if (window !== this.window) {
      this.signed.clear()
      this.rewritten.clear()
      this.window = window
    }
    return window
  }

  async get(
    video: VideoPath,
    file: string,
    verified: boolean
  ): Promise<string | undefined> {
    if (file !== 'index.m3u8' || verified)
      return await this.playlists.get(video, file)
    const at = this.now()
    const prefix = videoPrefix(video)
    const held = this.open.get(prefix)
    if (held != null && at - held.at < 1000) return await held.body
    // An unresolved request stays shared even if the store takes over a second.
    const pending = { at: Infinity, body: this.readOpen(video) }
    this.open.set(prefix, pending)
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

  rewrite(video: VideoPath, file: string, body: string): string {
    // Rotate the signature window before consulting the rewritten body.
    this.rotate()
    const key = spaceKey(video, file)
    const held = this.rewritten.get(key)
    if (held?.body === body && held.window === this.window) return held.result
    const result = rewriteMediaPlaylist(body, uri => this.sign(video, uri))
    this.rewritten.set(key, { body, window: this.window, result })
    return result
  }

  private async readOpen(video: VideoPath): Promise<string | undefined> {
    const response = await spaceRead(
      this.source,
      presignGetUrl({
        ...this.source.space,
        key: spaceKey(video, 'index.m3u8'),
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
