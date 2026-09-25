import type { GumboEventType } from '../../common/gumboEventTypes'

/**
 * What each event type counts toward in a line score.
 *
 * `countable` is whether a play of the type proves somebody was keeping a
 * sheet a hit could appear on. A game with only a score correction on it proves
 * nothing, and neither does a runner moving on his own. `stat` is the column
 * the play adds one to, for the side it belongs to.
 *
 * Every event type has an entry, so a new type cannot be counted by accident.
 */
export const EVENT_CLASS: Record<
  GumboEventType,
  {
    countable: boolean
    stat?: 'hit' | 'walk' | 'hitByPitch' | 'strikeout' | 'reachedOnError'
  }
> = {
  single: { countable: true, stat: 'hit' },
  double: { countable: true, stat: 'hit' },
  triple: { countable: true, stat: 'hit' },
  home_run: { countable: true, stat: 'hit' },
  strikeout: { countable: true, stat: 'strikeout' },
  strikeout_double_play: { countable: true, stat: 'strikeout' },
  walk: { countable: true, stat: 'walk' },
  intent_walk: { countable: false },
  hit_by_pitch: { countable: true, stat: 'hitByPitch' },
  field_out: { countable: true },
  other_out: { countable: true },
  grounded_into_double_play: { countable: true },
  triple_play: { countable: false },
  field_error: { countable: true, stat: 'reachedOnError' },
  fielders_choice: { countable: true },
  catcher_interference: { countable: false },
  manual_placement: { countable: true },
  sac_fly: { countable: true },
  sac_fly_double_play: { countable: true },
  sac_bunt: { countable: true },
  stolen_base: { countable: false },
  caught_stealing: { countable: false },
  pickoff_1b: { countable: false },
  pickoff_2b: { countable: false },
  pickoff_3b: { countable: false },
  pickoff_caught_stealing_2b: { countable: false },
  pickoff_caught_stealing_3b: { countable: false },
  pickoff_caught_stealing_home: { countable: false },
  defensive_indiff: { countable: false },
  placed_runner: { countable: false },
  wild_pitch: { countable: false },
  passed_ball: { countable: false },
  balk: { countable: false },
  game_advisory: { countable: false },
  score_correction: { countable: false },
  final_score: { countable: false }
}

function classOf(
  eventType: string
): (typeof EVENT_CLASS)[GumboEventType] | undefined {
  return (EVENT_CLASS as Record<string, (typeof EVENT_CLASS)[GumboEventType]>)[
    eventType
  ]
}

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
    const kind = classOf(event.eventType)
    if (kind?.countable === true) known = true
    const battingIsHome = event.halfInning === 'bottom'
    if (kind?.stat === 'hit') {
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
    if (kind?.stat === 'walk') {
      if (battingIsHome) walks.home += 1
      else walks.away += 1
    }
    if (kind?.stat === 'hitByPitch') {
      if (battingIsHome) hitByPitch.home += 1
      else hitByPitch.away += 1
    }
    // Charged to the side that was batting — these are the batters who struck
    // out. A side's *defensive* strikeouts are the other side's, which is why
    // they are not counted again.
    if (kind?.stat === 'strikeout') {
      if (battingIsHome) strikeouts.home += 1
      else strikeouts.away += 1
    }
    if (kind?.stat === 'reachedOnError') {
      if (battingIsHome) errors.away += 1
      else errors.home += 1
    }
  }
  return { hits, errors, walks, strikeouts, homeRuns, hitByPitch, known }
}
