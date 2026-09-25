import { eventTypeName, type GumboEventType } from './gumboEventTypes'

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
  single: 'singles',
  double: 'doubles',
  triple: 'triples',
  home_run: 'hits a home run',
  strikeout: null,
  strikeout_double_play: null,
  walk: 'walks',
  intent_walk: 'is walked intentionally',
  hit_by_pitch: 'is hit by a pitch',
  field_out: null,
  other_out: null,
  grounded_into_double_play: null,
  triple_play: null,
  field_error: null,
  fielders_choice: null,
  catcher_interference: "reaches on catcher's interference",
  manual_placement: 'is placed on base',
  sac_fly: 'hits a sacrifice fly',
  sac_fly_double_play: 'hits a sacrifice fly',
  sac_bunt: 'lays down a sacrifice bunt',
  stolen_base: 'steals a base',
  caught_stealing: null,
  pickoff_1b: null,
  pickoff_2b: null,
  pickoff_3b: null,
  pickoff_caught_stealing_2b: null,
  pickoff_caught_stealing_3b: null,
  pickoff_caught_stealing_home: null,
  defensive_indiff: null,
  placed_runner: 'is placed on base',
  wild_pitch: null,
  passed_ball: null,
  balk: null,
  game_advisory: null,
  score_correction: null,
  final_score: null
}

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
  if (
    outcome.eventType === 'strikeout' ||
    outcome.eventType === 'strikeout_double_play'
  ) {
    return outcome.credit?.role === 'pitcher'
      ? `${name} strikes out the batter`
      : `${name} picks up a dropped third strike`
  }
  const did =
    (DID_BY_TYPE as Record<string, string | null>)[outcome.eventType] ??
    DID_BY_CREDIT[outcome.eventType]
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
