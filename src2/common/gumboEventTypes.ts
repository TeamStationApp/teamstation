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
  'other_out',
  'game_advisory',
  'score_correction',
  'final_score'
] as const

export type GumboEventType = (typeof GUMBO_EVENT_TYPES)[number]

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(GUMBO_EVENT_TYPES)

export function isGumboEventType(value: string): value is GumboEventType {
  return EVENT_TYPE_SET.has(value)
}

/**
 * What a play of each type is called, when nobody on it is credited with
 * anything to name. A play is shown as GameStation's own reading of it, never
 * as a sentence stored with it.
 */
const EVENT_TYPE_NAMES: Record<GumboEventType, string> = {
  single: 'Single',
  double: 'Double',
  triple: 'Triple',
  home_run: 'Home run',
  strikeout: 'Strikeout',
  walk: 'Walk',
  intent_walk: 'Intentional walk',
  hit_by_pitch: 'Hit by pitch',
  field_out: 'Out',
  grounded_into_double_play: 'Double play',
  triple_play: 'Triple play',
  field_error: 'Error',
  fielders_choice: "Fielder's choice",
  catcher_interference: "Catcher's interference",
  sac_fly: 'Sacrifice fly',
  sac_bunt: 'Sacrifice bunt',
  stolen_base: 'Stolen base',
  caught_stealing: 'Caught stealing',
  wild_pitch: 'Wild pitch',
  passed_ball: 'Passed ball',
  balk: 'Balk',
  other_out: 'Out',
  game_advisory: 'Scorekeeper note',
  score_correction: 'Score correction',
  final_score: 'Final score'
}

export function eventTypeName(eventType: string | null): string {
  if (eventType == null || !isGumboEventType(eventType)) return 'Play'
  return EVENT_TYPE_NAMES[eventType]
}
