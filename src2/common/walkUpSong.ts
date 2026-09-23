/**
 * A player's walk-up song on one team: which recording, and the part of it
 * that plays when they come up to bat.
 *
 * - `appleMusic`: `providerId` is the Apple Music catalog id.
 * - `localFile`: a file on the songkeeper's phone. `providerId` is `lf:` and
 *   the first 16 hex characters of a sha256 of the normalised title, artist
 *   and whole-second duration, so another phone holding the same song finds
 *   it again. The file itself never leaves the phone.
 *
 * The clip is `startMs` to `endMs` within the song's `durationMs`, between
 * one second and one minute long. The same bounds are checks on the
 * `walk_up_songs` table (045walkUpSongs).
 */
export interface WalkUpSong {
  provider: WalkUpProvider
  providerId: string
  isrc: string | null
  title: string
  artist: string
  album: string | null
  artworkUrl: string | null
  durationMs: number
  startMs: number
  endMs: number
}

export const WALK_UP_PROVIDERS = ['appleMusic', 'localFile'] as const
export type WalkUpProvider = (typeof WALK_UP_PROVIDERS)[number]

/** The shortest and the longest clip. */
export const CLIP_MIN_MS = 1000
export const CLIP_MAX_MS = 60000

/** Longer than any song, and well inside a Postgres `integer`. */
const DURATION_MAX_MS = 24 * 60 * 60 * 1000
const TEXT_MAX_LENGTH = 300
const ID_MAX_LENGTH = 200
const URL_MAX_LENGTH = 2000

const LOCAL_FILE_ID = /^lf:[0-9a-f]{16}$/
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/

/**
 * A walk-up song as a request sends it or a row reads, or a `TypeError`
 * naming the first field that is wrong. Text is trimmed; an empty optional
 * text is `null`. An ISRC is read without hyphens and in capitals.
 */
export function asWalkUpSong(raw: unknown): WalkUpSong {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Expected an object')
  }
  const body = raw as Record<string, unknown>

  const provider = body.provider
  if (!WALK_UP_PROVIDERS.includes(provider as WalkUpProvider)) {
    throw new TypeError('provider: Expected appleMusic or localFile')
  }
  const providerId = text('providerId', body.providerId, ID_MAX_LENGTH)
  if (provider === 'localFile' && !LOCAL_FILE_ID.test(providerId)) {
    throw new TypeError('providerId: A local file is lf: and 16 hex digits')
  }
  if (provider === 'appleMusic' && providerId.startsWith('lf:')) {
    throw new TypeError('providerId: Expected an Apple Music id')
  }

  const isrcText = optionalText('isrc', body.isrc, 20)
  const isrc =
    isrcText == null ? null : isrcText.replace(/-/g, '').toUpperCase()
  if (isrc != null && !ISRC.test(isrc)) {
    throw new TypeError('isrc: Expected an ISRC')
  }

  const artworkUrl = optionalText('artworkUrl', body.artworkUrl, URL_MAX_LENGTH)
  if (artworkUrl != null && !/^https?:\/\//.test(artworkUrl)) {
    throw new TypeError('artworkUrl: Expected an http or https address')
  }

  const durationMs = whole('durationMs', body.durationMs)
  if (durationMs <= 0 || durationMs > DURATION_MAX_MS) {
    throw new TypeError('durationMs: Out of range')
  }
  const startMs = whole('startMs', body.startMs)
  if (startMs < 0) throw new TypeError('startMs: Out of range')
  const endMs = whole('endMs', body.endMs)
  if (endMs <= startMs || endMs > durationMs) {
    throw new TypeError('endMs: Must be after startMs and within the song')
  }
  const length = endMs - startMs
  if (length < CLIP_MIN_MS || length > CLIP_MAX_MS) {
    throw new TypeError('endMs: A clip is 1 to 60 seconds long')
  }

  return {
    provider: provider as WalkUpProvider,
    providerId,
    isrc,
    title: text('title', body.title, TEXT_MAX_LENGTH),
    artist: text('artist', body.artist, TEXT_MAX_LENGTH),
    album: optionalText('album', body.album, TEXT_MAX_LENGTH),
    artworkUrl,
    durationMs,
    startMs,
    endMs
  }
}

/** A clip as people read it: `0:10–0:25`. */
export function formatClip(
  song: Pick<WalkUpSong, 'startMs' | 'endMs'>
): string {
  return `${clock(song.startMs)}–${clock(song.endMs)}`
}

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function text(name: string, raw: unknown, max: number): string {
  if (typeof raw !== 'string') throw new TypeError(`${name}: Expected text`)
  const trimmed = raw.trim()
  if (trimmed === '') throw new TypeError(`${name}: Must not be empty`)
  if (trimmed.length > max) {
    throw new TypeError(`${name}: At most ${max} characters`)
  }
  return trimmed
}

function optionalText(name: string, raw: unknown, max: number): string | null {
  if (raw == null) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  return text(name, raw, max)
}

function whole(name: string, raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new TypeError(`${name}: Expected a whole number of milliseconds`)
  }
  return raw
}
