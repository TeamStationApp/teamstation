import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The token on a `/media/<expires>/<sig>/<dir>/<rest>` URL.
 *
 * One token covers every file of one video, because a player fetches a
 * playlist and then every segment it names, and asking the database once per
 * segment would be the slowest thing on the host. The signature covers the
 * expiry and the directory together, so a token minted for one video cannot be
 * moved to another, and nothing in the path is trusted: `verifyMediaPath`
 * rejects anything that climbs out of `dir` before the proxy is ever told to
 * serve a byte.
 *
 * The reverse proxy calls `/internal/media-auth` with the original URL and
 * serves the file itself, so media bytes never pass through Node.
 */

/** How long a playback URL is good for. The player refetches on a 403. */
export const MEDIA_TOKEN_TTL_SEC = 6 * 60 * 60

export interface MediaToken {
  /** Unix seconds. */
  expires: number
  /** base64url HMAC over `expires + "/" + dir`. */
  sig: string
}

export interface MediaPath {
  expires: number
  sig: string
  /** The video's directory, e.g. `work/videos/vid_abc` or `peertube/…`. */
  dir: string
  /** The file within that directory, e.g. `master.m3u8`. */
  rest: string
}

export function signMediaDir(
  secret: string,
  dir: string,
  nowMs: number = Date.now(),
  ttlSec: number = MEDIA_TOKEN_TTL_SEC
): MediaToken {
  const expires = Math.floor(nowMs / 1000) + ttlSec
  return { expires, sig: signature(secret, expires, dir) }
}

/** The whole URL path a player is given, ready to hang off the site's origin. */
export function mediaUrlPath(
  secret: string,
  dir: string,
  file: string,
  nowMs: number = Date.now(),
  ttlSec: number = MEDIA_TOKEN_TTL_SEC
): string {
  const { expires, sig } = signMediaDir(secret, dir, nowMs, ttlSec)
  return `/media/${expires}/${sig}/${dir}/${file}`
}

/**
 * Splits `/media/<expires>/<sig>/<dir>/<rest>` up.
 *
 * `dir` is taken as everything up to the last slash rather than a fixed number
 * of segments, so directories can nest as deeply as PeerTube's do.
 */
export function parseMediaPath(path: string): MediaPath | undefined {
  const match = /^\/media\/(\d+)\/([A-Za-z0-9_-]+)\/(.+)$/.exec(path)
  if (match == null) return undefined
  const [, expiresText, sig, tail] = match
  const cut = tail.lastIndexOf('/')
  if (cut <= 0) return undefined
  return {
    expires: Number(expiresText),
    sig,
    dir: tail.slice(0, cut),
    rest: tail.slice(cut + 1)
  }
}

export type MediaRefusal =
  | 'malformed'
  | 'expired'
  | 'badSignature'
  | 'escapesDirectory'

/**
 * Whether to serve this path, and if not, why. In memory: no database, no file
 * system, because this runs once per segment of every video being watched.
 */
export function verifyMediaPath(
  secret: string,
  path: string,
  nowMs: number = Date.now()
): { ok: true; media: MediaPath } | { ok: false; reason: MediaRefusal } {
  const media = parseMediaPath(path)
  if (media == null) return { ok: false, reason: 'malformed' }

  // Checked before the signature: a traversal is a refusal whether or not
  // whoever sent it managed to sign it.
  if (!isContained(media.dir) || !isContained(media.rest)) {
    return { ok: false, reason: 'escapesDirectory' }
  }
  if (media.expires * 1000 <= nowMs) return { ok: false, reason: 'expired' }
  if (!matches(signature(secret, media.expires, media.dir), media.sig)) {
    return { ok: false, reason: 'badSignature' }
  }
  return { ok: true, media }
}

/**
 * A token for a URL the API itself serves, rather than one the proxy serves.
 *
 * A `<video>` element cannot send an Authorization header, so the playlists
 * the API serves out of the Space carry their permission in the query string.
 * Same key, same expiry, different shape: `<expires>.<signature>`.
 */
export function signQueryToken(
  secret: string,
  subject: string,
  nowMs: number = Date.now(),
  ttlSec: number = MEDIA_TOKEN_TTL_SEC
): string {
  const expires = Math.floor(nowMs / 1000) + ttlSec
  return `${expires}.${signature(secret, expires, subject)}`
}

export function verifyQueryToken(
  secret: string,
  subject: string,
  token: unknown,
  nowMs: number = Date.now()
): boolean {
  if (typeof token !== 'string') return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const expires = Number(token.slice(0, dot))
  if (!Number.isInteger(expires) || expires * 1000 <= nowMs) return false
  return matches(signature(secret, expires, subject), token.slice(dot + 1))
}

function signature(secret: string, expires: number, dir: string): string {
  return createHmac('sha256', secret)
    .update(`${expires}/${dir}`)
    .digest('base64url')
}

/** Constant time, so a wrong signature does not leak how nearly right it was. */
function matches(expected: string, given: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * A path that stays inside its directory: no `..`, no absolute path, no
 * backslash (Windows separators, which some clients send), no NUL, and no
 * empty segment that would collapse into one.
 */
function isContained(part: string): boolean {
  if (part === '' || part.startsWith('/') || part.includes('\\')) return false
  if (part.includes('\0')) return false
  return part.split('/').every(segment => {
    return segment !== '' && segment !== '.' && segment !== '..'
  })
}
