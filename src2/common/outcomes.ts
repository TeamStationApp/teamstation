import { type GumboEventType, normalizeEventType } from './gumboEventTypes'

/**
 * What one player did on a play, in two or three words.
 *
 * The highlighter already writes a line for every credited outcome — `Single:
 * Jordan P`, `Ground out: Jordan P (SS) to Casey B (1B)`, `Run: Hunter P` —
 * and that wording is shared with the chapter titles GS Distributor writes, so
 * a play reads the same everywhere. On a player's own page the name is the one
 * thing the reader already knows, and a list that says it back forty times is
 * a list of one name.
 *
 * So this takes the same outcome and says only what was done. It works from
 * the engine's own label rather than inventing a second vocabulary: the head
 * of the label — everything before the colon — is the outcome, which is why
 * `Caught stealing 2nd` and `Out at 3rd` come through with the base intact
 * without this file knowing what a base is.
 */
export interface CreditedOutcomeLike {
  eventType: string
  /** `Single: Jordan P`. */
  label: string
  credit: { role: string } | null
}

/**
 * Where the event type alone reads better than the label's head, and null
 * where the label says more. Every stored event type has an entry.
 */
export const OUTCOME_BY_TYPE: Record<GumboEventType, string | null> = {
  pickoff_1b: null,
  pickoff_2b: null,
  pickoff_3b: null,
  pitcher_step_off: null,
  pickoff_error_1b: null,
  pickoff_error_2b: null,
  pickoff_error_3b: null,
  batter_timeout: null,
  mound_visit: null,
  no_pitch: null,
  single: 'Single',
  double: 'Double',
  triple: 'Triple',
  home_run: 'Home run',
  double_play: 'Double play',
  field_error: null,
  error: null,
  field_out: null,
  fielders_choice: null,
  fielders_choice_out: null,
  force_out: null,
  grounded_into_double_play: null,
  grounded_into_triple_play: null,
  strikeout: null,
  strike_out: null,
  strikeout_double_play: null,
  strikeout_triple_play: null,
  triple_play: null,
  sac_fly: 'Sacrifice fly',
  catcher_interf: null,
  batter_interference: null,
  fielder_interference: null,
  runner_interference: null,
  fan_interference: null,
  batter_turn: null,
  ejection: null,
  cs_double_play: null,
  defensive_indiff: null,
  sac_fly_double_play: 'Sacrifice fly',
  sac_bunt: 'Sacrifice bunt',
  sac_bunt_double_play: 'Sacrifice bunt',
  walk: 'Walk',
  intent_walk: 'Intentional walk',
  hit_by_pitch: 'Hit by pitch',
  injury: null,
  os_ruling_pending_prior: null,
  os_ruling_pending_primary: null,
  at_bat_start: null,
  passed_ball: null,
  other_advance: null,
  runner_double_play: null,
  runner_placed: 'Placed runner',
  pitching_substitution: 'Pitching change',
  offensive_substitution: 'Substitution',
  defensive_switch: 'Position change',
  umpire_substitution: null,
  pitcher_switch: null,
  game_advisory: null,
  stolen_base: null,
  stolen_base_2b: 'Stole second',
  stolen_base_3b: 'Stole third',
  stolen_base_home: 'Stole home',
  caught_stealing: null,
  caught_stealing_2b: null,
  caught_stealing_3b: null,
  caught_stealing_home: null,
  defensive_substitution: 'Substitution',
  pickoff_caught_stealing_2b: null,
  pickoff_caught_stealing_3b: null,
  pickoff_caught_stealing_home: null,
  balk: null,
  forced_balk: null,
  wild_pitch: null,
  other_out: null,
  final_score: null,
  score_correction: null,
  gs_manual_placement: 'Placed on base',
  gs_batter_out: null
}

/** The strikeouts, which read by who is credited with them. */
const STRIKEOUTS: ReadonlySet<string> = new Set([
  'strikeout',
  'strike_out',
  'strikeout_double_play',
  'strikeout_triple_play'
])

/** Credit types that are not play types but read best by their type. */
const BY_CREDIT: Record<string, string> = {
  run: 'Run scored',
  double_play: 'Double play'
}

export function outcomeName(outcome: CreditedOutcomeLike): string {
  const role = outcome.credit?.role ?? ''
  const eventType = normalizeEventType(outcome.eventType)

  // A strikeout belongs to whoever is credited with it, and the two readings
  // are opposite sides of the same play: the pitcher earned it, the catcher
  // picked up a dropped third strike.
  if (STRIKEOUTS.has(eventType)) {
    return role === 'pitcher' ? 'Strikeout pitching' : 'Dropped third strike'
  }

  const known =
    (OUTCOME_BY_TYPE as Record<string, string | null>)[eventType] ??
    BY_CREDIT[eventType]
  if (known != null) return known

  return headOf(outcome.label)
}

/** `Ground out: Jordan P (SS) to Casey B (1B)` → `Ground out`. */
function headOf(label: string): string {
  const head = label.split(':')[0].trim()
  return head === '' ? 'Play' : head
}
