import type { GumboEventType } from './gumboEventTypes'

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
  single: 'Single',
  double: 'Double',
  triple: 'Triple',
  home_run: 'Home run',
  strikeout: null,
  strikeout_double_play: null,
  walk: 'Walk',
  intent_walk: 'Intentional walk',
  hit_by_pitch: 'Hit by pitch',
  field_out: null,
  other_out: null,
  grounded_into_double_play: null,
  triple_play: null,
  field_error: null,
  fielders_choice: null,
  catcher_interference: null,
  manual_placement: 'Placed on base',
  sac_fly: 'Sacrifice fly',
  sac_fly_double_play: 'Sacrifice fly',
  sac_bunt: 'Sacrifice bunt',
  stolen_base: null,
  caught_stealing: null,
  pickoff_1b: null,
  pickoff_2b: null,
  pickoff_3b: null,
  pickoff_caught_stealing_2b: null,
  pickoff_caught_stealing_3b: null,
  pickoff_caught_stealing_home: null,
  defensive_indiff: null,
  placed_runner: 'Placed runner',
  wild_pitch: null,
  passed_ball: null,
  balk: null,
  game_advisory: null,
  score_correction: null,
  final_score: null
}

/** Credit types that are not play types but read best by their type. */
const BY_CREDIT: Record<string, string> = {
  run: 'Run scored',
  double_play: 'Double play'
}

export function outcomeName(outcome: CreditedOutcomeLike): string {
  const role = outcome.credit?.role ?? ''

  // A strikeout belongs to whoever is credited with it, and the two readings
  // are opposite sides of the same play: the pitcher earned it, the catcher
  // picked up a dropped third strike.
  if (
    outcome.eventType === 'strikeout' ||
    outcome.eventType === 'strikeout_double_play'
  ) {
    return role === 'pitcher' ? 'Strikeout pitching' : 'Dropped third strike'
  }

  const known =
    (OUTCOME_BY_TYPE as Record<string, string | null>)[outcome.eventType] ??
    BY_CREDIT[outcome.eventType]
  if (known != null) return known

  return headOf(outcome.label)
}

/** `Ground out: Jordan P (SS) to Casey B (1B)` → `Ground out`. */
function headOf(label: string): string {
  const head = label.split(':')[0].trim()
  return head === '' ? 'Play' : head
}
