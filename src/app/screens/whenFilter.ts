export { endsAt, LIVE_GRACE_MS, nextGameIndex } from '../../common/nextGame'

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
