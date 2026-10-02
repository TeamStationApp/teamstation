import {
  type GumboEventType,
  normalizeEventType
} from '../../common/gumboEventTypes'

/**
 * What each event type counts toward in a line score.
 *
 * `countable` is whether a play of the type proves somebody was keeping a
 * sheet a hit could appear on. A game with only a score correction on it proves
 * nothing, and neither does a runner moving on his own. `stat` is the column
 * the play adds one to, for the side it belongs to. An `error` is charged to
 * the side fielding: a batter who reached on one, a runner who took a base on
 * one, or a pickoff throw that got away. A play that names its errors in its
 * runners' credits is counted by those instead (`hitsAndErrors`).
 *
 * Every event type has an entry, so a new type cannot be counted by accident.
 */
export const EVENT_CLASS: Record<
  GumboEventType,
  {
    countable: boolean
    stat?: 'hit' | 'walk' | 'hitByPitch' | 'strikeout' | 'error'
  }
> = {
  pickoff_1b: { countable: false },
  pickoff_2b: { countable: false },
  pickoff_3b: { countable: false },
  pitcher_step_off: { countable: false },
  pickoff_error_1b: { countable: false, stat: 'error' },
  pickoff_error_2b: { countable: false, stat: 'error' },
  pickoff_error_3b: { countable: false, stat: 'error' },
  batter_timeout: { countable: false },
  mound_visit: { countable: false },
  no_pitch: { countable: false },
  single: { countable: true, stat: 'hit' },
  double: { countable: true, stat: 'hit' },
  triple: { countable: true, stat: 'hit' },
  home_run: { countable: true, stat: 'hit' },
  double_play: { countable: true },
  field_error: { countable: true, stat: 'error' },
  error: { countable: false, stat: 'error' },
  field_out: { countable: true },
  fielders_choice: { countable: true },
  fielders_choice_out: { countable: true },
  force_out: { countable: true },
  grounded_into_double_play: { countable: true },
  grounded_into_triple_play: { countable: true },
  strikeout: { countable: true, stat: 'strikeout' },
  strike_out: { countable: true, stat: 'strikeout' },
  strikeout_double_play: { countable: true, stat: 'strikeout' },
  strikeout_triple_play: { countable: true, stat: 'strikeout' },
  triple_play: { countable: false },
  sac_fly: { countable: true },
  catcher_interf: { countable: false },
  batter_interference: { countable: true },
  fielder_interference: { countable: false },
  runner_interference: { countable: false },
  fan_interference: { countable: true },
  batter_turn: { countable: false },
  ejection: { countable: false },
  cs_double_play: { countable: false },
  defensive_indiff: { countable: false },
  sac_fly_double_play: { countable: true },
  sac_bunt: { countable: true },
  sac_bunt_double_play: { countable: true },
  walk: { countable: true, stat: 'walk' },
  intent_walk: { countable: false },
  hit_by_pitch: { countable: true, stat: 'hitByPitch' },
  injury: { countable: false },
  os_ruling_pending_prior: { countable: false },
  os_ruling_pending_primary: { countable: false },
  at_bat_start: { countable: false },
  passed_ball: { countable: false },
  other_advance: { countable: false },
  runner_double_play: { countable: false },
  runner_placed: { countable: false },
  pitching_substitution: { countable: false },
  offensive_substitution: { countable: false },
  defensive_switch: { countable: false },
  umpire_substitution: { countable: false },
  pitcher_switch: { countable: false },
  game_advisory: { countable: false },
  stolen_base: { countable: false },
  stolen_base_2b: { countable: false },
  stolen_base_3b: { countable: false },
  stolen_base_home: { countable: false },
  caught_stealing: { countable: false },
  caught_stealing_2b: { countable: false },
  caught_stealing_3b: { countable: false },
  caught_stealing_home: { countable: false },
  defensive_substitution: { countable: false },
  pickoff_caught_stealing_2b: { countable: false },
  pickoff_caught_stealing_3b: { countable: false },
  pickoff_caught_stealing_home: { countable: false },
  balk: { countable: false },
  forced_balk: { countable: false },
  wild_pitch: { countable: false },
  other_out: { countable: true },
  final_score: { countable: false },
  score_correction: { countable: false },
  ts_manual_placement: { countable: true },
  ts_batter_out: { countable: true },
  ts_batting_order: { countable: false }
}

function classOf(
  eventType: string
): (typeof EVENT_CLASS)[GumboEventType] | undefined {
  return (EVENT_CLASS as Record<string, (typeof EVENT_CLASS)[GumboEventType]>)[
    normalizeEventType(eventType)
  ]
}

/**
 * Hits and errors per side, counted from the plays given.
 *
 * A hit belongs to the side batting. An **error belongs to the side that made
 * it**, which is the side fielding — the opposite team from the batter. That
 * is the one that gets written backwards, which is why it is a named function
 * with a test rather than four lines inside a longer one.
 *
 * `errorCredits` is the number of fielding and throwing errors credited on
 * the play's runners: one for each, whichever runner it let on or along, so a
 * throw that got away on a single counts. A play with none that is an error
 * by its type (a batter who reached on one with nobody charged, as an import
 * sends it) counts one. Each error is counted once, from
 * its credit when there is one and from the type only when there is not.
 */
export function hitsAndErrors(
  events: Array<{
    halfInning: 'top' | 'bottom' | null
    eventType: string
    errorCredits?: number
  }>
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
    const credited = event.errorCredits ?? 0
    const charged = credited > 0 ? credited : kind?.stat === 'error' ? 1 : 0
    if (battingIsHome) errors.away += charged
    else errors.home += charged
  }
  return { hits, errors, walks, strikeouts, homeRuns, hitByPitch, known }
}
