import { DEFAULT_EVENT_DURATION_MS } from '../../common/eventTime'

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

/** How long after its end a game still marked live keeps the schedule on it. */
export const LIVE_GRACE_MS = 2 * 60 * 60 * 1000

/** When an event ends: its end time, or its start and the usual length. */
export function endsAt(game: {
  startAt: string | null
  endAt?: string | null
}): number {
  if (game.endAt != null) return Date.parse(game.endAt)
  return game.startAt == null
    ? Number.NaN
    : Date.parse(game.startAt) + DEFAULT_EVENT_DURATION_MS
}

/**
 * The game or event a team's schedule opens on, as an index into
 * `chronological`'s order.
 *
 * It is the first one, a practice or another event as much as a game, that
 * has not ended yet and has no score, unless a game still marked live comes
 * before it: one that has started and is no more than `LIVE_GRACE_MS` past
 * its end, which would otherwise be scrolled past. Live never takes the
 * schedule past something still to come, and a game scored ahead of its date
 * or a scoring session nobody finished does not hold it. With nothing to
 * come, a season that is over opens on the last one played. A cancelled one
 * is never it. -1 for none.
 */
export function nextGameIndex<
  T extends Datable & { status: string; endAt?: string | null }
>(sorted: readonly T[], now = Date.now()): number {
  const playable = (game: T): boolean => game.status !== 'cancelled'
  const ahead = sorted.findIndex(
    game => playable(game) && game.awayScore == null && endsAt(game) > now
  )
  const live = sorted.findLastIndex(
    game =>
      game.status === 'inProgress' &&
      game.startAt != null &&
      Date.parse(game.startAt) <= now &&
      now <= endsAt(game) + LIVE_GRACE_MS
  )
  if (live >= 0 && ahead >= 0) return Math.min(live, ahead)
  if (live >= 0) return live
  if (ahead >= 0) return ahead
  const dated = sorted.findLastIndex(
    game => playable(game) && game.startAt != null
  )
  return dated >= 0 ? dated : sorted.length - 1
}
