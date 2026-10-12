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

/**
 * `May 20`, without the weekday.
 *
 * On a phone the row has about 140px for its third line, and `Sun, Sep 13 ·
 * 12:30 PM · 3 videos` needs 212. The weekday is the part a reader can most
 * afford to lose: the date is right there beside it.
 */
export function shortDateNoWeekday(iso: string | null): string {
  if (iso == null) return 'Date to be confirmed'
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return 'Date to be confirmed'
  return when.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

/**
 * `May 20, 2026` — a date on a record rather than on a fixture.
 *
 * With the year, and an em dash for nothing: "when was this account made" and
 * "when did they last sign in" are answered across years, and a missing
 * answer means never rather than "to be confirmed".
 */
export function calendarDate(iso: string | null): string {
  if (iso == null) return '\u2014'
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return '\u2014'
  return when.toLocaleDateString(undefined, {
    year: 'numeric',
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
 * The date on a schedule row: a short month over a two-digit day, and the
 * weekday and time on their own line. Always en-US, so a phone set to
 * another language still reads `Oct` and `4:45 PM`.
 */
export function scheduleDate(iso: string | null): {
  month: string
  day: string
  when: string
} {
  if (iso == null) return { month: '\u2014', day: '', when: '' }
  const when = new Date(iso)
  if (Number.isNaN(when.getTime()))
    return { month: '\u2014', day: '', when: '' }
  const weekday = when.toLocaleDateString('en-US', { weekday: 'short' })
  const time = when.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  })
  return {
    month: when.toLocaleDateString('en-US', { month: 'short' }),
    day: when.toLocaleDateString('en-US', { day: '2-digit' }),
    when: `${weekday} \u00b7 ${time}`
  }
}

/**
 * What to write across the middle of a scoreboard.
 *
 * A game with no score is not 0–0, it is a game that has not happened, so it
 * says when it is instead. A game under way already has a score, and that
 * score is not a final one: the numbers sit on either side, and the middle
 * says the game is still live.
 */
export function gameStatusLine(game: ScoredGame): string {
  if (game.status === 'inProgress') return 'LIVE'
  if (game.awayScore == null || game.homeScore == null) {
    const time = shortTime(game.startAt)
    return time === '' ? game.status.toUpperCase() : time.toUpperCase()
  }
  return 'FINAL'
}

/**
 * Which side won, or undefined for a tie, a game still being played, or one
 * not yet played.
 */
export function winnerOf(game: ScoredGame): 'away' | 'home' | undefined {
  if (game.status !== 'final') return undefined
  const { awayScore, homeScore } = game
  if (awayScore == null || homeScore == null) return undefined
  if (awayScore > homeScore) return 'away'
  if (homeScore > awayScore) return 'home'
  return undefined
}

/**
 * `W 4–0` from the point of view of one team, or nothing when the game is
 * not final.
 *
 * An en dash, not a hyphen: it is a score, not a range of numbers, and the
 * hyphen is visibly too short beside the numerals at this weight. A game
 * still being played has a score and no winner yet, so it gets no result.
 */
export function resultFor(
  game: ScoredGame & { homeTeamId: string; awayTeamId: string },
  teamId: string
): { label: string; tone: 'win' | 'loss' | 'neutral' } | undefined {
  if (game.status !== 'final') return undefined
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

/**
 * How the two teams of a game are written on one row.
 *
 * `@` means the home side is second; `vs` means the first side is at home.
 * That is how a score is read aloud, and it saves a reader from having to
 * already know that the away team conventionally comes first.
 *
 * With a `fromTeamId` the row is written from that team's point of view, which
 * is what a team's own page wants. Without one — the all-seasons feed, the
 * schedule — there is no side to take, so it states the fixture: away first.
 *
 * One helper rather than a format at each call site, because that is how the
 * same game ends up written two ways on two screens.
 */
export function matchupLines(
  game: {
    homeTeamId: string
    awayTeamId: string
    homeTeamName: string
    awayTeamName: string
    eventKind?: 'game' | 'event'
    title?: string | null
  },
  fromTeamId?: string
): { first: string; second: string } {
  if (game.eventKind === 'event')
    return { first: game.title ?? 'Team event', second: '' }
  if (fromTeamId === game.homeTeamId) {
    return { first: game.homeTeamName, second: `vs ${game.awayTeamName}` }
  }
  if (fromTeamId === game.awayTeamId) {
    return { first: game.awayTeamName, second: `@ ${game.homeTeamName}` }
  }
  return { first: game.awayTeamName, second: `@ ${game.homeTeamName}` }
}

/**
 * How a player bats and throws, the way a scorecard writes it: `B: R · T: L`.
 *
 * A switch hitter is `B: L/R`. Half-known is half-shown — `B: L` on its own is
 * true, and padding it out with `T: —` is not. Nothing known at all returns
 * undefined, and the line is not drawn: a dash says somebody looked and found
 * nothing, which is not what an empty column means.
 */
export function battingLine(person: {
  bats?: 'left' | 'right' | 'switch' | null
  throws?: 'left' | 'right' | null
}): string | undefined {
  const parts: string[] = []
  if (person.bats != null) parts.push(`B: ${handLabel(person.bats)}`)
  if (person.throws != null) parts.push(`T: ${handLabel(person.throws)}`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

function handLabel(hand: 'left' | 'right' | 'switch'): string {
  if (hand === 'switch') return 'L/R'
  return hand === 'left' ? 'L' : 'R'
}

/**
 * A date and the exact time of day, to the second: `Sat, Jun 22 2026 · 4:47:13 PM`.
 *
 * The seconds are the point. A highlight list is a list of moments, and two
 * plays in the same at-bat are a minute apart; a time without seconds makes
 * them look like the same one.
 */
export function exactDateTime(iso: string | null): string {
  if (iso == null) return ''
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  const day = when.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  const time = when.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
  return `${day} · ${time}`
}
