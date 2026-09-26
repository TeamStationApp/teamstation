/**
 * The event types a stored play may name: MLB's own list
 * (`gumbo/reference/eventTypes.json`, from `statsapi.mlb.com/api/v1/eventTypes`),
 * then GameStation's extensions. A new type is added here, and every
 * classifier of event types (`hitsAndErrors`, `outcomeName`, `describePlay`,
 * the stats builder) is told what it is.
 *
 * The extensions are `final_score` and `score_correction`, which an import
 * posts, `gs_manual_placement`, a batter the scorer put on
 * base by hand, `gs_batter_out`, a batter out on a play MLB has no code
 * for ("Batter Out — Other"), and `gs_batting_order`, the action a scorer's
 * change of batting order writes.
 */
export const GUMBO_EVENT_TYPES = [
  'pickoff_1b',
  'pickoff_2b',
  'pickoff_3b',
  'pitcher_step_off',
  'pickoff_error_1b',
  'pickoff_error_2b',
  'pickoff_error_3b',
  'batter_timeout',
  'mound_visit',
  'no_pitch',
  'single',
  'double',
  'triple',
  'home_run',
  'double_play',
  'field_error',
  'error',
  'field_out',
  'fielders_choice',
  'fielders_choice_out',
  'force_out',
  'grounded_into_double_play',
  'grounded_into_triple_play',
  'strikeout',
  'strike_out',
  'strikeout_double_play',
  'strikeout_triple_play',
  'triple_play',
  'sac_fly',
  'catcher_interf',
  'batter_interference',
  'fielder_interference',
  'runner_interference',
  'fan_interference',
  'batter_turn',
  'ejection',
  'cs_double_play',
  'defensive_indiff',
  'sac_fly_double_play',
  'sac_bunt',
  'sac_bunt_double_play',
  'walk',
  'intent_walk',
  'hit_by_pitch',
  'injury',
  'os_ruling_pending_prior',
  'os_ruling_pending_primary',
  'at_bat_start',
  'passed_ball',
  'other_advance',
  'runner_double_play',
  'runner_placed',
  'pitching_substitution',
  'offensive_substitution',
  'defensive_switch',
  'umpire_substitution',
  'pitcher_switch',
  'game_advisory',
  'stolen_base',
  'stolen_base_2b',
  'stolen_base_3b',
  'stolen_base_home',
  'caught_stealing',
  'caught_stealing_2b',
  'caught_stealing_3b',
  'caught_stealing_home',
  'defensive_substitution',
  'pickoff_caught_stealing_2b',
  'pickoff_caught_stealing_3b',
  'pickoff_caught_stealing_home',
  'balk',
  'forced_balk',
  'wild_pitch',
  'other_out',
  // GameStation's extensions.
  'final_score',
  'score_correction',
  'gs_manual_placement',
  'gs_batter_out',
  'gs_batting_order'
] as const

export type GumboEventType = (typeof GUMBO_EVENT_TYPES)[number]

/** The extensions, which MLB's list does not have. */
export const GUMBO_EXTENSION_EVENT_TYPES: readonly GumboEventType[] = [
  'final_score',
  'score_correction',
  'gs_manual_placement',
  'gs_batter_out',
  'gs_batting_order'
]

/**
 * Codes that are not on the list but are still accepted as input, and the
 * code each is stored as. The scoring engine and older imports write them;
 * migration 039 renamed the ones already stored.
 */
export const LEGACY_EVENT_TYPES = {
  catcher_interference: 'catcher_interf',
  placed_runner: 'runner_placed',
  manual_placement: 'gs_manual_placement'
} as const satisfies Record<string, GumboEventType>

export type LegacyEventType = keyof typeof LEGACY_EVENT_TYPES

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(GUMBO_EVENT_TYPES)

export function isGumboEventType(value: string): value is GumboEventType {
  return EVENT_TYPE_SET.has(value)
}

export function isLegacyEventType(value: string): value is LegacyEventType {
  return Object.hasOwn(LEGACY_EVENT_TYPES, value)
}

/**
 * The listed code for a legacy one, and any other code unchanged, so a reader
 * of plays treats `catcher_interference` and `catcher_interf` alike.
 */
export function normalizeEventType(value: string): string {
  return isLegacyEventType(value) ? LEGACY_EVENT_TYPES[value] : value
}

/**
 * What a play of each type is called, when nobody on it is credited with
 * anything to name. A play is shown as GameStation's own reading of it, never
 * as a sentence stored with it. The names are MLB's, in GameStation's
 * sentence case.
 */
const EVENT_TYPE_NAMES: Record<GumboEventType, string> = {
  pickoff_1b: 'Pickoff at first',
  pickoff_2b: 'Pickoff at second',
  pickoff_3b: 'Pickoff at third',
  pitcher_step_off: 'Pitcher step off',
  pickoff_error_1b: 'Pickoff error at first',
  pickoff_error_2b: 'Pickoff error at second',
  pickoff_error_3b: 'Pickoff error at third',
  batter_timeout: 'Batter timeout',
  mound_visit: 'Mound visit',
  no_pitch: 'No pitch',
  single: 'Single',
  double: 'Double',
  triple: 'Triple',
  home_run: 'Home run',
  double_play: 'Double play',
  field_error: 'Error',
  error: 'Error',
  field_out: 'Out',
  fielders_choice: "Fielder's choice",
  fielders_choice_out: "Fielder's choice out",
  force_out: 'Forceout',
  grounded_into_double_play: 'Double play',
  grounded_into_triple_play: 'Triple play',
  strikeout: 'Strikeout',
  strike_out: 'Strikeout',
  strikeout_double_play: 'Strikeout double play',
  strikeout_triple_play: 'Strikeout triple play',
  triple_play: 'Triple play',
  sac_fly: 'Sacrifice fly',
  catcher_interf: "Catcher's interference",
  batter_interference: 'Batter interference',
  fielder_interference: 'Fielder interference',
  runner_interference: 'Runner interference',
  fan_interference: 'Fan interference',
  batter_turn: 'Batter turn',
  ejection: 'Ejection',
  cs_double_play: 'Caught stealing double play',
  defensive_indiff: 'Defensive indifference',
  sac_fly_double_play: 'Sacrifice fly double play',
  sac_bunt: 'Sacrifice bunt',
  sac_bunt_double_play: 'Sacrifice bunt double play',
  walk: 'Walk',
  intent_walk: 'Intentional walk',
  hit_by_pitch: 'Hit by pitch',
  injury: 'Injury',
  os_ruling_pending_prior: 'Official scorer ruling pending',
  os_ruling_pending_primary: 'Official scorer ruling pending',
  at_bat_start: 'At bat start',
  passed_ball: 'Passed ball',
  other_advance: 'Runner advance',
  runner_double_play: 'Runner double play',
  runner_placed: 'Runner placed',
  pitching_substitution: 'Pitching change',
  offensive_substitution: 'Offensive substitution',
  defensive_switch: 'Defensive switch',
  umpire_substitution: 'Umpire substitution',
  pitcher_switch: 'Pitcher switch',
  game_advisory: 'Scorekeeper note',
  stolen_base: 'Stolen base',
  stolen_base_2b: 'Stolen base, second',
  stolen_base_3b: 'Stolen base, third',
  stolen_base_home: 'Stolen base, home',
  caught_stealing: 'Caught stealing',
  caught_stealing_2b: 'Caught stealing second',
  caught_stealing_3b: 'Caught stealing third',
  caught_stealing_home: 'Caught stealing home',
  defensive_substitution: 'Defensive substitution',
  pickoff_caught_stealing_2b: 'Picked off stealing second',
  pickoff_caught_stealing_3b: 'Picked off stealing third',
  pickoff_caught_stealing_home: 'Picked off stealing home',
  balk: 'Balk',
  forced_balk: 'Disengagement violation',
  wild_pitch: 'Wild pitch',
  other_out: 'Out',
  final_score: 'Final score',
  score_correction: 'Score correction',
  gs_manual_placement: 'Batter placed on base',
  gs_batter_out: 'Out',
  gs_batting_order: 'Batting order change'
}

export function eventTypeName(eventType: string | null): string {
  if (eventType == null) return 'Play'
  const listed = normalizeEventType(eventType)
  return isGumboEventType(listed) ? EVENT_TYPE_NAMES[listed] : 'Play'
}
