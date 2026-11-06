import { randomBytes } from 'node:crypto'

/**
 * Where a video's objects live in the Space.
 *
 * A video with a secret keeps its media under `videos/<id>-<secret>/`, a path
 * nobody can guess, so its pieces and recording can be public and fetched
 * through a CDN without a signature. The secret is 32 lowercase hex
 * characters, 128 random bits, set only at a moment when nothing of the video
 * is under its old prefix yet, so one video never spans two prefixes.
 *
 * A video with no secret (from before secrets, or a read-only-source video)
 * keeps `videos/<id>/`, private and signed, as before. Stills stay at
 * `videos/<id>/stills/` whatever the secret: they are private, and their
 * callers have only a video id.
 */

/** A video, as far as its objects' keys are concerned. */
export interface VideoPath {
  id: string
  /** Null for a video on its old path. */
  spaceSecret: string | null
}

const SECRET = /^[0-9a-f]{32}$/

/** A secret path's secret segment, with what precedes it and its first four. */
const SECRET_IN_TEXT = /(videos\/[^/\s]+?-)([0-9a-f]{4})[0-9a-f]{28}(?=\/)/g

/**
 * Text with each secret path in it cut to the secret's first four characters,
 * `videos/<id>-1a2b…/`. The path is the read capability for a video's media,
 * so an error that names a key must not carry it into a log.
 */
export function withoutSecrets(text: string): string {
  return text.replace(SECRET_IN_TEXT, '$1$2…')
}

/** A new secret: 32 lowercase hex characters from `randomBytes(16)`. */
export function newSpaceSecret(): string {
  return randomBytes(16).toString('hex')
}

export function isSpaceSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET.test(value)
}

/** `videos/<id>-<secret>/`, or `videos/<id>/` for a video with no secret. */
export function videoPrefix(video: VideoPath): string {
  if (video.spaceSecret == null) return oldVideoPrefix(video.id)
  if (!isSpaceSecret(video.spaceSecret))
    throw new Error('Invalid video space secret')
  return `videos/${video.id}-${video.spaceSecret}/`
}

/** The prefix a video's objects had before secrets, and its stills keep. */
export function oldVideoPrefix(videoId: string): string {
  return `videos/${videoId}/`
}

/** One object of a video: `videoPrefix` and the file's name. */
export function videoKey(video: VideoPath, file: string): string {
  return `${videoPrefix(video)}${file}`
}

/**
 * Whether a key is under some secret prefix of this video: its second path
 * segment is exactly `<id>-` and 32 hex characters. Ids can contain `-` and
 * differ in length, so `videos/<id>-` alone could match another video.
 */
export function isSecretKeyOf(videoId: string, key: string): boolean {
  const segment = key.split('/')[1] ?? ''
  return (
    key.startsWith('videos/') &&
    segment.startsWith(`${videoId}-`) &&
    SECRET.test(segment.slice(videoId.length + 1))
  )
}

/** The headers an upload of one object carries. */
export interface UploadHeaders {
  acl?: 'public-read'
  cacheControl?: string
}

/**
 * What an object is uploaded with. Only under a secret path: there, pieces and
 * recordings are public and cached for the CDN endpoint's own 600 s (which
 * also bounds how long a deleted video stays at the edge), init files are
 * public but asked about again on every use, and playlists stay private,
 * served only by the API. A reconnecting writer writes `init.mp4` again under
 * the same name, maybe with a new resolution or rotation, and a viewer given
 * the old one from the edge cannot decode the new writer's pieces; a viewer
 * fetches it once per start, so the extra request costs nothing. A video with
 * no secret uploads as before, private, with neither header.
 */
export function uploadHeadersFor(
  spaceSecret: string | null,
  file: string
): UploadHeaders {
  if (spaceSecret == null) return {}
  if (/^seg\d+\.m4s$/.test(file) || file === 'video.mp4')
    return { acl: 'public-read', cacheControl: 'public, max-age=600' }
  if (/^init[^/]*\.mp4$/.test(file))
    return { acl: 'public-read', cacheControl: 'no-cache' }
  return {}
}
