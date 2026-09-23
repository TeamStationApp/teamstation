/**
 * The event types a stored play may name: Gumbo's own names for what happened
 * at the plate or on the bases, plus `score_correction` and `final_score`. A
 * new type is added here.
 */
const GUMBO_EVENT_TYPES = [
  'single',
  'double',
  'triple',
  'home_run',
  'strikeout',
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'field_out',
  'grounded_into_double_play',
  'triple_play',
  'field_error',
  'fielders_choice',
  'catcher_interference',
  'sac_fly',
  'sac_bunt',
  'stolen_base',
  'caught_stealing',
  'wild_pitch',
  'passed_ball',
  'balk',
  'score_correction',
  'final_score'
] as const

export type GumboEventType = (typeof GUMBO_EVENT_TYPES)[number]

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(GUMBO_EVENT_TYPES)

export function isGumboEventType(value: string): value is GumboEventType {
  return EVENT_TYPE_SET.has(value)
}
