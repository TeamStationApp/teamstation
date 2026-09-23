const HIT_TYPES = new Set(['single', 'double', 'triple', 'home_run'])

/**
 * The plays that prove somebody was keeping a sheet a hit could appear on.
 * A game with only a score correction on it proves nothing.
 */
const COUNTABLE = new Set([
  ...HIT_TYPES,
  'field_out',
  'strikeout',
  'walk',
  'field_error',
  'hit_by_pitch',
  'sac_fly',
  'sac_bunt',
  'grounded_into_double_play',
  'fielders_choice'
])

/**
 * Hits and errors per side, counted from the plays given.
 *
 * A hit belongs to the side batting. An **error belongs to the side that made
 * it**, which is the side fielding — the opposite team from the batter. That
 * is the one that gets written backwards, which is why it is a named function
 * with a test rather than four lines inside a longer one.
 */
export function hitsAndErrors(
  events: Array<{ halfInning: 'top' | 'bottom' | null; eventType: string }>
): {
  hits: { home: number; away: number }
  errors: { home: number; away: number }
  /** Walks, charged to the side that batted. */
  walks: { home: number; away: number }
  /** Hit batters, charged to the side that batted. */
  hitByPitch: { home: number; away: number }
  /** Strikeouts, charged to the side that batted. */
  strikeouts: { home: number; away: number }
  /** Home runs, charged to the side that batted. */
  homeRuns: { home: number; away: number }
  /**
   * Whether the plays can answer the question at all.
   *
   * A game whose only entry is a final score has no hits and no errors
   * *recorded*, which is not the same as none happening. `0H · 0E` beside
   * thirteen runs is a claim the plays do not support, and nothing is shown
   * that the plays cannot support.
   */
  known: boolean
} {
  const hits = { home: 0, away: 0 }
  const errors = { home: 0, away: 0 }
  const walks = { home: 0, away: 0 }
  const hitByPitch = { home: 0, away: 0 }
  const strikeouts = { home: 0, away: 0 }
  const homeRuns = { home: 0, away: 0 }
  let known = false
  for (const event of events) {
    if (event.halfInning == null) continue
    // A play we recognise at all means the sheet was kept.
    if (COUNTABLE.has(event.eventType)) known = true
    const battingIsHome = event.halfInning === 'bottom'
    if (HIT_TYPES.has(event.eventType)) {
      if (battingIsHome) hits.home += 1
      else hits.away += 1
    }
    if (event.eventType === 'home_run') {
      if (battingIsHome) homeRuns.home += 1
      else homeRuns.away += 1
    }
    // A walk, and only a walk. `hit_by_pitch` reaches base the same way and is
    // a different column in every box score ever printed; merging the two here
    // would make the game card disagree with the box score two taps away.
    if (event.eventType === 'walk') {
      if (battingIsHome) walks.home += 1
      else walks.away += 1
    }
    if (event.eventType === 'hit_by_pitch') {
      if (battingIsHome) hitByPitch.home += 1
      else hitByPitch.away += 1
    }
    // Charged to the side that was batting — these are the batters who struck
    // out. A side's *defensive* strikeouts are the other side's, which is why
    // they are not counted again.
    if (event.eventType === 'strikeout') {
      if (battingIsHome) strikeouts.home += 1
      else strikeouts.away += 1
    }
    if (event.eventType === 'field_error') {
      if (battingIsHome) errors.away += 1
      else errors.home += 1
    }
  }
  return { hits, errors, walks, strikeouts, homeRuns, hitByPitch, known }
}
