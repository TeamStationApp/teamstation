import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/**
 * How long a game in this season is meant to run.
 *
 * An ERA is earned runs per game, so it divides by the innings a game here has
 * — nine in the major leagues, six in this one. Nothing in the plays says
 * so, and a divisor we guessed would make every ERA on the site wrong by a
 * third, so it is measured from the games themselves: the length most of a
 * season's games ran. A short game and an extra-innings game are outliers
 * either side of it and the mode ignores both, which is the point of using it
 * — but only where there are enough games to mean anything, because a fall
 * season of two rain-shortened games says nothing at all. Where that does not
 * work there is no figure, and an ERA is not shown without one.
 */
/**
 * How many games a season has to have before its own length means anything.
 *
 * Eight, with the modal length covering half of them. Under that a couple of
 * time-limited afternoons can make a six-inning league look like a four-inning
 * one, and an ERA 50% too high is worse than no ERA.
 */
const ENOUGH_GAMES = 8

export function modalInnings(lengths: number[]): number | null {
  const counts = new Map<number, number>()
  for (const length of lengths) {
    if (!Number.isFinite(length) || length < 1) continue
    counts.set(length, (counts.get(length) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  // The longest that ties, because a regulation game can be cut short and
  // cannot be cut long.
  let best = 0
  let bestCount = 0
  for (const [length, seen] of counts) {
    if (seen > bestCount || (seen === bestCount && length > best)) {
      best = length
      bestCount = seen
    }
  }
  return best
}

/**
 * The innings in one line score, which is how many the game got through.
 *
 * The shorter of the two sides, because the visiting side's row can carry a
 * trailing inning it never played: four of the five games in one season here
 * read `[4,0,0,0,0,3,0]` against `[0,2,0,2,0,2]`, a padded seventh that would
 * have made a six-inning league look like a seven-inning one. An inning both
 * sides batted in is an inning the game got to.
 */
export function inningsOf(linescore: unknown): number | null {
  if (linescore == null || typeof linescore !== 'object') return null
  const lengths: number[] = []
  for (const side of ['home', 'away'] as const) {
    const runs = (linescore as Record<string, { runs?: unknown }>)[side]?.runs
    if (Array.isArray(runs)) lengths.push(runs.length)
  }
  if (lengths.length === 0) return null
  const shortest = Math.min(...lengths)
  return shortest === 0 ? null : shortest
}

/**
 * Works out a season's regulation length, and records it.
 *
 * Run at the end of an ingest, when the line scores are as good as they are
 * going to get. Left null where not enough of the season's own games can say:
 * nobody knows, and an ERA is not shown without it.
 */
export async function recordInningsPerGame(
  db: Kysely<Database>,
  seasonId: string
): Promise<number | null> {
  const innings = await measuredDivisor(db, seasonId)
  if (innings == null) return null

  await db
    .updateTable('seasons')
    .set({ innings_per_game: innings, updated_at: new Date() })
    .where('id', '=', seasonId)
    .execute()
  return innings
}

/** The length the games ran, where there are enough of them to mean anything. */
async function measuredDivisor(
  db: Kysely<Database>,
  seasonId: string
): Promise<number | null> {
  const games = await db
    .selectFrom('games')
    .select(['linescore'])
    .where('season_id', '=', seasonId)
    .where('status', '=', 'final')
    .execute()

  const lengths: number[] = []
  for (const game of games) {
    const innings = inningsOf(game.linescore)
    if (innings != null) lengths.push(innings)
  }
  if (lengths.length < ENOUGH_GAMES) return null
  const innings = modalInnings(lengths)
  if (innings == null) return null
  const agreeing = lengths.filter(length => length === innings).length
  return agreeing * 2 >= lengths.length ? innings : null
}
