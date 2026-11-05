import { DEFAULT_EVENT_DURATION_MS } from './eventTime'

/**
 * Which row a schedule opens on: the one rule, used by the app's lists and by
 * the server's `around=next` pages.
 */

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
  T extends {
    startAt: string | null
    awayScore: number | null
    status: string
    endAt?: string | null
  }
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

/** The game the umpire table opens on: the first under way or still to start. */
export function initialUmpireGame<
  T extends { status: string; startAt: string }
>(games: readonly T[], now: number): T | undefined {
  return (
    games.find(
      g => g.status === 'inProgress' || Date.parse(g.startAt) >= now
    ) ?? games.at(-1)
  )
}
