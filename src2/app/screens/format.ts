/**
 * Turning stored values into the words on the screen.
 *
 * Gathered in one file because a date written two ways on two screens looks
 * like two different dates, and because these are the parts worth testing
 * without a browser.
 */

export interface ScoredGame {
  startAt: string | null
  status: string
  homeScore: number | null
  awayScore: number | null
}

/** `Wed, May 20` — a date a parent recognises, in their own time zone. */
export function shortDate(iso: string | null): string {
  if (iso == null) return 'Date to be confirmed'
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return 'Date to be confirmed'
  return when.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

/** `10:00 AM`, or nothing when the game has no time. */
export function shortTime(iso: string | null): string {
  if (iso == null) return ''
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * What to write across the middle of a scoreboard.
 *
 * A game with no score is not 0–0, it is a game that has not happened, so it
 * says when it is instead.
 */
export function gameStatusLine(game: ScoredGame): string {
  if (game.awayScore == null || game.homeScore == null) {
    const time = shortTime(game.startAt)
    return time === '' ? game.status.toUpperCase() : time.toUpperCase()
  }
  return 'FINAL'
}

/** Which side won, or undefined for a tie or a game not yet played. */
export function winnerOf(game: ScoredGame): 'away' | 'home' | undefined {
  const { awayScore, homeScore } = game
  if (awayScore == null || homeScore == null) return undefined
  if (awayScore > homeScore) return 'away'
  if (homeScore > awayScore) return 'home'
  return undefined
}

/**
 * `W 4–0` from the point of view of one team, or nothing when unplayed.
 *
 * An en dash, not a hyphen: it is a score, not a range of numbers, and the
 * hyphen is visibly too short beside the numerals at this weight.
 */
export function resultFor(
  game: ScoredGame & { homeTeamId: string; awayTeamId: string },
  teamId: string
): { label: string; tone: 'win' | 'loss' | 'neutral' } | undefined {
  const { awayScore, homeScore } = game
  if (awayScore == null || homeScore == null) return undefined
  const isHome = game.homeTeamId === teamId
  const ours = isHome ? homeScore : awayScore
  const theirs = isHome ? awayScore : homeScore
  if (ours === theirs) return { label: `T ${ours}–${theirs}`, tone: 'neutral' }
  return ours > theirs
    ? { label: `W ${ours}–${theirs}`, tone: 'win' }
    : { label: `L ${ours}–${theirs}`, tone: 'loss' }
}

/** `1h 24m`, `58m`, or nothing. */
export function duration(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** `1:24:10` — a position within a video. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`
}
