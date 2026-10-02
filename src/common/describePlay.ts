import {
  eventTypeName,
  type GumboEventType,
  normalizeEventType
} from './gumboEventTypes'

// A play in a sentence, written by GameStation from what it knows about the
// play — its type, who is credited with what, the half-inning, the score —
// and never from a sentence stored with it. Worked out whenever a play is
// shown, so it always reads the way this code reads a play.
//
//   Bottom 4th: Palmer A doubles. Chase T scores. 3–5

export interface DescribedCredit {
  eventType: string
  /** The engine's own label, `Fly out: Luke T (LF)`. */
  label: string
  credit: { name: string; role: string; position: string | null } | null
}

export interface DescribedPlay {
  eventType: string | null
  inning?: number | null
  halfInning?: string | null
  awayScore?: number | null
  homeScore?: number | null
  /** The credits a highlight shows for the play. */
  credits: DescribedCredit[]
}

/**
 * What somebody credited with each outcome did, after their name, or null
 * where the engine's label says it better. Every stored event type has an
 * entry.
 */
export const DID_BY_TYPE: Record<GumboEventType, string | null> = {
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
  single: 'singles',
  double: 'doubles',
  triple: 'triples',
  home_run: 'hits a home run',
  double_play: null,
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
  sac_fly: 'hits a sacrifice fly',
  catcher_interf: "reaches on catcher's interference",
  batter_interference: null,
  fielder_interference: null,
  runner_interference: null,
  fan_interference: null,
  batter_turn: null,
  ejection: null,
  cs_double_play: null,
  defensive_indiff: null,
  sac_fly_double_play: 'hits a sacrifice fly',
  sac_bunt: 'lays down a sacrifice bunt',
  sac_bunt_double_play: 'lays down a sacrifice bunt',
  walk: 'walks',
  intent_walk: 'is walked intentionally',
  hit_by_pitch: 'is hit by a pitch',
  injury: null,
  os_ruling_pending_prior: null,
  os_ruling_pending_primary: null,
  at_bat_start: null,
  passed_ball: null,
  other_advance: null,
  runner_double_play: null,
  runner_placed: 'is placed on base',
  pitching_substitution: 'comes in to pitch',
  offensive_substitution: 'comes in to bat',
  defensive_switch: 'moves to a new position',
  umpire_substitution: null,
  pitcher_switch: null,
  game_advisory: null,
  stolen_base: 'steals a base',
  stolen_base_2b: 'steals second',
  stolen_base_3b: 'steals third',
  stolen_base_home: 'steals home',
  caught_stealing: null,
  caught_stealing_2b: null,
  caught_stealing_3b: null,
  caught_stealing_home: null,
  defensive_substitution: 'comes in on defense',
  pickoff_caught_stealing_2b: null,
  pickoff_caught_stealing_3b: null,
  pickoff_caught_stealing_home: null,
  balk: null,
  forced_balk: null,
  wild_pitch: null,
  other_out: null,
  final_score: null,
  score_correction: null,
  gs_manual_placement: 'is placed on base',
  gs_batter_out: null,
  gs_batting_order: null
}

/** The strikeouts, whose clause turns on who is credited with them. */
const STRIKEOUTS: ReadonlySet<string> = new Set([
  'strikeout',
  'strike_out',
  'strikeout_double_play',
  'strikeout_triple_play'
])

/** Credit types that are not play types. */
const DID_BY_CREDIT: Record<string, string> = { run: 'scores' }

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** One credited outcome as a clause. */
function clause(outcome: DescribedCredit): string {
  const name = outcome.credit?.name ?? ''
  const [head, ...rest] = outcome.label.split(':')
  const detail = rest.join(':').trim()
  if (name === '') return head.trim() === '' ? 'Play' : head.trim()
  const eventType = normalizeEventType(outcome.eventType)
  if (STRIKEOUTS.has(eventType)) {
    return outcome.credit?.role === 'pitcher'
      ? `${name} strikes out the batter`
      : `${name} picks up a dropped third strike`
  }
  const did =
    (DID_BY_TYPE as Record<string, string | null>)[eventType] ??
    DID_BY_CREDIT[eventType]
  if (did != null) return `${name} ${did}`
  // A fielding credit: the engine's label already says who and where,
  // `Ground out: Jordan P (SS) to Casey B (1B)`.
  return detail === ''
    ? `${head.trim()} by ${name}`
    : `${head.trim()}, ${detail}`
}

/**
 * The sentence for one play: the half-inning when it is known, then a clause
 * for each credit, or the type's own name when nobody on the play is credited
 * with anything, then the score when both sides have one.
 */
export function describePlay(play: DescribedPlay): string {
  const when =
    typeof play.inning === 'number' &&
    (play.halfInning === 'top' || play.halfInning === 'bottom')
      ? `${play.halfInning === 'top' ? 'Top' : 'Bottom'} ${ordinal(play.inning)}: `
      : ''
  const what =
    play.credits.length === 0
      ? eventTypeName(play.eventType)
      : play.credits.map(clause).join('. ')
  const score =
    typeof play.awayScore === 'number' && typeof play.homeScore === 'number'
      ? ` ${play.awayScore}–${play.homeScore}`
      : ''
  return `${when}${what}.${score}`
}
