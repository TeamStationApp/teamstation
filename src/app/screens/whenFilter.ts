/**
 * Past, upcoming, or all — the one rule, used by every list that offers it.
 *
 * A game is upcoming only if it has not happened **yet**. A fixture nobody
 * ever scored does not stay upcoming for ever: the app was offering a game
 * from February as something still to come, which is what §19 of the plan was
 * written to stop. Splitting on the score alone is what did that, and the
 * season page went on doing it after the schedule stopped, because the rule
 * lived at the call site. It lives here now.
 */
export type When = 'past' | 'upcoming' | 'all'

interface Datable {
  startAt: string | null
  awayScore: number | null
}

/** Not yet played, and not yet due. */
export function isAhead(game: Datable, now = Date.now()): boolean {
  return game.startAt != null && Date.parse(game.startAt) > now
}

/** The games a filter asks for, nearest to now first in both directions. */
export function gamesFor<T extends Datable>(
  games: readonly T[],
  when: When,
  now = Date.now()
): T[] {
  const shown =
    when === 'all'
      ? [...games]
      : when === 'upcoming'
        ? games.filter(game => game.awayScore == null && isAhead(game, now))
        : games.filter(game => game.awayScore != null || !isAhead(game, now))
  // Newest first looking back, soonest first looking forward: either way the
  // game nearest to now is at the top.
  return shown.sort((a, b) => {
    const order = (a.startAt ?? '').localeCompare(b.startAt ?? '')
    return when === 'upcoming' ? order : -order
  })
}

/** Oldest first, the way a season is read; a game with no date goes last. */
export function chronological<T extends Datable>(games: readonly T[]): T[] {
  return [...games].sort((a, b) => {
    if (a.startAt == null || b.startAt == null) {
      return (a.startAt == null ? 1 : 0) - (b.startAt == null ? 1 : 0)
    }
    return a.startAt.localeCompare(b.startAt)
  })
}

/**
 * The game a team's schedule opens on, as an index into `chronological`'s
 * order: the one being played now, or else the next still to play by the
 * same rule as Upcoming, or else — a season that is over — the last one
 * played. A cancelled game is never it. Of two games still marked live, the
 * later is the one being played; the earlier is a scoring session nobody
 * finished. -1 for no games.
 */
export function nextGameIndex<T extends Datable & { status: string }>(
  sorted: readonly T[],
  now = Date.now()
): number {
  const live = sorted.findLastIndex(game => game.status === 'inProgress')
  if (live >= 0) return live
  const playable = (game: T): boolean => game.status !== 'cancelled'
  const ahead = sorted.findIndex(
    game => playable(game) && game.awayScore == null && isAhead(game, now)
  )
  if (ahead >= 0) return ahead
  const dated = sorted.findLastIndex(
    game => playable(game) && game.startAt != null
  )
  return dated >= 0 ? dated : sorted.length - 1
}
