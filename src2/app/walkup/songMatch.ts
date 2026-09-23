import type { WalkUpSong } from '../../common/walkUpSong'
import type { SongCandidate } from './walkUpMusicTypes'

/**
 * How near two recordings' lengths must be to count as the same song when
 * nothing else ties them: a re-encode or a different store's copy of one
 * recording differs by a second or so, a live take or a remaster by more.
 */
export const DURATION_TOLERANCE_MS = 2000

/**
 * A title or an artist as two stores that spell it differently still agree
 * on: lower case, accents off, anything in brackets gone — `(Remastered
 * 2004)`, `[Live]` — a featured artist and everything after them gone, `&`
 * read as `and`, and every run of punctuation and space one space.
 *
 * The Kotlin module hashes local files with exactly this
 * (`LocalFileId.kt`), and `localFileId.fixtures.json` holds both to it:
 * change one and the other, and the fixtures, in the same commit.
 */
export function normaliseSongText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(
      /(^|[^\p{L}\p{N}])(feat|ft|featuring)(\.|[^\p{L}\p{N}.]).*$/u,
      '$1'
    )
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * The candidate that is this song, or null.
 *
 * In order: the same provider id — an Apple Music catalog id, or a local
 * file's `lf:` hash — then the same ISRC, then the same normalised title and
 * artist with the length within `DURATION_TOLERANCE_MS`. The first rule that
 * finds anything decides, so an ISRC match beats a better-looking title.
 */
export function matchSong(
  song: Pick<
    WalkUpSong,
    'providerId' | 'isrc' | 'title' | 'artist' | 'durationMs'
  >,
  candidates: readonly SongCandidate[]
): SongCandidate | null {
  const byId = candidates.find(
    candidate => candidate.providerId === song.providerId
  )
  if (byId != null) return byId
  const isrc = song.isrc?.toUpperCase()
  if (isrc != null && isrc !== '') {
    const byIsrc = candidates.find(
      candidate => candidate.isrc?.toUpperCase() === isrc
    )
    if (byIsrc != null) return byIsrc
  }
  const title = normaliseSongText(song.title)
  const artist = normaliseSongText(song.artist)
  return (
    candidates.find(
      candidate =>
        normaliseSongText(candidate.title) === title &&
        normaliseSongText(candidate.artist) === artist &&
        Math.abs(candidate.durationMs - song.durationMs) <=
          DURATION_TOLERANCE_MS
    ) ?? null
  )
}
