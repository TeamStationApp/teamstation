import type { Cleaner } from 'cleaners'

/** By which inning a requirement must be met: a number, or the game's end. */
export const INNING_DEADLINES = [3, 4, 5, 'end'] as const
export type InningDeadline = (typeof INNING_DEADLINES)[number]

/** The defensive outs a player must play, and a large roster's fewer. */
export const DEFENSIVE_OUTS = [3, 6, 9] as const
export type DefensiveOuts = (typeof DEFENSIVE_OUTS)[number]

export const SHORTENED_GAME_CHOICES = [
  'always',
  'localOption',
  'never'
] as const
export const PARTIAL_INNING_CHOICES = ['fullOnly', 'anyAppearance'] as const
export const INFIELD_POSITIONS = ['P', 'C', '1B', '2B', 'SS', '3B'] as const
export type InfieldPosition = (typeof INFIELD_POSITIONS)[number]
export const CATCHER_INFIELD_CHOICES = ['off', 'always', 'largeRoster'] as const
export const SITTING_ORDER_CHOICES = [
  'secondAfterAll',
  'thirdAfterAll',
  'off'
] as const
/** Rotate Every N Innings: 0 is Off. */
export const ROTATE_EVERY_CHOICES = [0, 1, 2] as const
export const CATCHER_INNING_CHOICES = [3, 4] as const

/**
 * A season's or a team's Playing Time Rules: what a coach's game plan is
 * warned against. Nothing here blocks a plan; every enabled rule warns.
 */
export interface PlayingTimeRules {
  mandatoryPlay: boolean
  defensiveOutsRequired: DefensiveOuts
  mustBeConsecutive: boolean
  reducedForLargeRosters: boolean
  /** "When ≥ ___ players present". */
  largeRosterPlayers: number
  /** "require only ___ outs". */
  largeRosterOuts: DefensiveOuts
  applyInShortenedGames: (typeof SHORTENED_GAME_CHOICES)[number]
  stricterMinimumInnings: boolean
  minimumFullInnings: number
  minimumInningsBy: InningDeadline
  countPartialInnings: (typeof PARTIAL_INNING_CHOICES)[number]
  requireMinimumInfield: boolean
  infieldInningsRequired: number
  infieldPositions: InfieldPosition[]
  catcherCountsAsInfield: (typeof CATCHER_INFIELD_CHOICES)[number]
  infieldBy: InningDeadline
  requireMinimumOutfield: boolean
  outfieldInningsRequired: number
  outfieldBy: InningDeadline
  enforceSittingLimits: boolean
  noConsecutiveSits: boolean
  equalSittingOrder: (typeof SITTING_ORDER_CHOICES)[number]
  maxSitsPerGame: number
  startingBatteryExemptFromSitting: boolean
  limitInningsAtPosition: boolean
  maxInningsPerPosition: number | 'unlimited'
  mustPlayInfieldAndOutfield: boolean
  rotateEvery: (typeof ROTATE_EVERY_CHOICES)[number]
  catcherInningLimit: boolean
  catcherMaxInnings: (typeof CATCHER_INNING_CHOICES)[number]
  catcherBlocksPitching: boolean
  catcherBlocksIfCatchesFourth: boolean
  startingBatteryExemptFromMinimums: boolean
  continuousBatting: boolean
  lateArrivalsToEnd: boolean
  departuresSkipWithoutOut: boolean
  trackSeasonInfieldBalance: boolean
  rotateLeadoff: boolean
  mustPlayNextSuggestions: boolean
}

export type PlayingTimeRuleKey = keyof PlayingTimeRules

/** Every rule off, and each value where the rule starts once it is on. */
export const DEFAULT_PLAYING_TIME_RULES: PlayingTimeRules = {
  mandatoryPlay: false,
  defensiveOutsRequired: 6,
  mustBeConsecutive: false,
  reducedForLargeRosters: false,
  largeRosterPlayers: 15,
  largeRosterOuts: 3,
  applyInShortenedGames: 'always',
  stricterMinimumInnings: false,
  minimumFullInnings: 2,
  minimumInningsBy: 'end',
  countPartialInnings: 'anyAppearance',
  requireMinimumInfield: false,
  infieldInningsRequired: 1,
  infieldPositions: [...INFIELD_POSITIONS],
  catcherCountsAsInfield: 'always',
  infieldBy: 'end',
  requireMinimumOutfield: false,
  outfieldInningsRequired: 1,
  outfieldBy: 'end',
  enforceSittingLimits: false,
  noConsecutiveSits: true,
  equalSittingOrder: 'secondAfterAll',
  maxSitsPerGame: 1,
  startingBatteryExemptFromSitting: true,
  limitInningsAtPosition: false,
  maxInningsPerPosition: 3,
  mustPlayInfieldAndOutfield: false,
  rotateEvery: 0,
  catcherInningLimit: false,
  catcherMaxInnings: 4,
  catcherBlocksPitching: false,
  catcherBlocksIfCatchesFourth: false,
  startingBatteryExemptFromMinimums: true,
  continuousBatting: false,
  lateArrivalsToEnd: false,
  departuresSkipWithoutOut: false,
  trackSeasonInfieldBalance: false,
  rotateLeadoff: false,
  mustPlayNextSuggestions: false
}

export const PLAYING_TIME_RULE_KEYS = Object.keys(
  DEFAULT_PLAYING_TIME_RULES
) as PlayingTimeRuleKey[]

/** The whole-number rules' ends, where their steppers stop. */
export const PLAYING_TIME_RANGES = {
  largeRosterPlayers: { min: 10, max: 25 },
  minimumFullInnings: { min: 1, max: 6 },
  infieldInningsRequired: { min: 1, max: 4 },
  outfieldInningsRequired: { min: 1, max: 3 },
  maxSitsPerGame: { min: 0, max: 3 },
  /** Above these is Unlimited. */
  maxInningsPerPosition: { min: 2, max: 6 }
} as const

function refused(key: PlayingTimeRuleKey, expected: string): TypeError {
  return new TypeError(`playingTimeRules.${key}: expected ${expected}`)
}

const toggle =
  (key: PlayingTimeRuleKey): Cleaner<boolean> =>
  raw => {
    if (typeof raw !== 'boolean') throw refused(key, 'a boolean')
    return raw
  }

function choice<const T extends ReadonlyArray<string | number>>(
  key: PlayingTimeRuleKey,
  values: T
): Cleaner<T[number]> {
  return raw => {
    if (!values.includes(raw as T[number]))
      throw refused(key, `one of ${values.join(', ')}`)
    return raw as T[number]
  }
}

const count =
  (key: keyof typeof PLAYING_TIME_RANGES): Cleaner<number> =>
  raw => {
    const { min, max } = PLAYING_TIME_RANGES[key]
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < min ||
      raw > max
    )
      throw refused(key, `a whole number from ${min} to ${max}`)
    return raw
  }

const cleaners: {
  [Key in PlayingTimeRuleKey]: Cleaner<PlayingTimeRules[Key]>
} = {
  mandatoryPlay: toggle('mandatoryPlay'),
  defensiveOutsRequired: choice('defensiveOutsRequired', DEFENSIVE_OUTS),
  mustBeConsecutive: toggle('mustBeConsecutive'),
  reducedForLargeRosters: toggle('reducedForLargeRosters'),
  largeRosterPlayers: count('largeRosterPlayers'),
  largeRosterOuts: choice('largeRosterOuts', DEFENSIVE_OUTS),
  applyInShortenedGames: choice(
    'applyInShortenedGames',
    SHORTENED_GAME_CHOICES
  ),
  stricterMinimumInnings: toggle('stricterMinimumInnings'),
  minimumFullInnings: count('minimumFullInnings'),
  minimumInningsBy: choice('minimumInningsBy', INNING_DEADLINES),
  countPartialInnings: choice('countPartialInnings', PARTIAL_INNING_CHOICES),
  requireMinimumInfield: toggle('requireMinimumInfield'),
  infieldInningsRequired: count('infieldInningsRequired'),
  infieldPositions: raw => {
    const position = choice('infieldPositions', INFIELD_POSITIONS)
    if (!Array.isArray(raw))
      throw refused('infieldPositions', 'a list of positions')
    // Each position once, in the field's order, however they were sent.
    const chosen = new Set(raw.map(position))
    return INFIELD_POSITIONS.filter(infield => chosen.has(infield))
  },
  catcherCountsAsInfield: choice(
    'catcherCountsAsInfield',
    CATCHER_INFIELD_CHOICES
  ),
  infieldBy: choice('infieldBy', INNING_DEADLINES),
  requireMinimumOutfield: toggle('requireMinimumOutfield'),
  outfieldInningsRequired: count('outfieldInningsRequired'),
  outfieldBy: choice('outfieldBy', INNING_DEADLINES),
  enforceSittingLimits: toggle('enforceSittingLimits'),
  noConsecutiveSits: toggle('noConsecutiveSits'),
  equalSittingOrder: choice('equalSittingOrder', SITTING_ORDER_CHOICES),
  maxSitsPerGame: count('maxSitsPerGame'),
  startingBatteryExemptFromSitting: toggle('startingBatteryExemptFromSitting'),
  limitInningsAtPosition: toggle('limitInningsAtPosition'),
  maxInningsPerPosition: raw =>
    raw === 'unlimited' ? raw : count('maxInningsPerPosition')(raw),
  mustPlayInfieldAndOutfield: toggle('mustPlayInfieldAndOutfield'),
  rotateEvery: choice('rotateEvery', ROTATE_EVERY_CHOICES),
  catcherInningLimit: toggle('catcherInningLimit'),
  catcherMaxInnings: choice('catcherMaxInnings', CATCHER_INNING_CHOICES),
  catcherBlocksPitching: toggle('catcherBlocksPitching'),
  catcherBlocksIfCatchesFourth: toggle('catcherBlocksIfCatchesFourth'),
  startingBatteryExemptFromMinimums: toggle(
    'startingBatteryExemptFromMinimums'
  ),
  continuousBatting: toggle('continuousBatting'),
  lateArrivalsToEnd: toggle('lateArrivalsToEnd'),
  departuresSkipWithoutOut: toggle('departuresSkipWithoutOut'),
  trackSeasonInfieldBalance: toggle('trackSeasonInfieldBalance'),
  rotateLeadoff: toggle('rotateLeadoff'),
  mustPlayNextSuggestions: toggle('mustPlayNextSuggestions')
}

/**
 * A whole set of rules. A missing key takes its default, so a set stored
 * before a rule existed still reads; a value out of range, or not one of a
 * rule's choices, is a `TypeError` naming the rule. Unknown keys are dropped.
 */
export function asPlayingTimeRules(raw: unknown): PlayingTimeRules {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw))
    throw new TypeError('playingTimeRules: expected an object')
  const given = raw as Record<string, unknown>
  const rules: Record<string, unknown> = {}
  for (const key of PLAYING_TIME_RULE_KEYS) {
    const value = given[key]
    const fallback = DEFAULT_PLAYING_TIME_RULES[key]
    rules[key] =
      value != null
        ? cleaners[key](value)
        : Array.isArray(fallback)
          ? [...fallback]
          : fallback
  }
  return rules as unknown as PlayingTimeRules
}

const eitherMinimum = (rules: PlayingTimeRules): boolean =>
  rules.requireMinimumInfield || rules.requireMinimumOutfield

/** What each dependent row needs to be on before it can be changed. */
const ROW_NEEDS: Partial<
  Record<PlayingTimeRuleKey, (rules: PlayingTimeRules) => boolean>
> = {
  defensiveOutsRequired: rules => rules.mandatoryPlay,
  mustBeConsecutive: rules => rules.mandatoryPlay,
  reducedForLargeRosters: rules => rules.mandatoryPlay,
  largeRosterPlayers: rules =>
    rules.mandatoryPlay && rules.reducedForLargeRosters,
  largeRosterOuts: rules => rules.mandatoryPlay && rules.reducedForLargeRosters,
  applyInShortenedGames: rules => rules.mandatoryPlay,
  minimumFullInnings: rules => rules.stricterMinimumInnings,
  minimumInningsBy: rules => rules.stricterMinimumInnings,
  countPartialInnings: rules => rules.stricterMinimumInnings,
  infieldInningsRequired: rules => rules.requireMinimumInfield,
  infieldPositions: rules => rules.requireMinimumInfield,
  catcherCountsAsInfield: rules => rules.requireMinimumInfield,
  infieldBy: rules => rules.requireMinimumInfield,
  outfieldInningsRequired: rules => rules.requireMinimumOutfield,
  outfieldBy: rules => rules.requireMinimumOutfield,
  noConsecutiveSits: rules => rules.enforceSittingLimits,
  equalSittingOrder: rules => rules.enforceSittingLimits,
  maxSitsPerGame: rules => rules.enforceSittingLimits,
  startingBatteryExemptFromSitting: rules => rules.enforceSittingLimits,
  maxInningsPerPosition: rules => rules.limitInningsAtPosition,
  rotateEvery: rules => rules.limitInningsAtPosition,
  mustPlayInfieldAndOutfield: eitherMinimum,
  startingBatteryExemptFromMinimums: eitherMinimum,
  catcherMaxInnings: rules => rules.catcherInningLimit,
  catcherBlocksIfCatchesFourth: rules => rules.catcherBlocksPitching,
  lateArrivalsToEnd: rules => rules.continuousBatting,
  departuresSkipWithoutOut: rules => rules.continuousBatting
}

/**
 * Whether a rule's row can be changed, and whether the rule applies: a row
 * that depends on another stays off while that one is off.
 */
export function ruleRowEnabled(
  rules: PlayingTimeRules,
  key: PlayingTimeRuleKey
): boolean {
  return ROW_NEEDS[key]?.(rules) ?? true
}

/**
 * The rules a team plays by: its own set when it overrides its season's,
 * otherwise its season's, otherwise none.
 */
export function inheritedRules(
  own: PlayingTimeRules | null,
  season: PlayingTimeRules | null
): {
  rules: PlayingTimeRules | null
  source: 'team' | 'season' | 'none'
} {
  if (own != null) return { rules: own, source: 'team' }
  if (season != null) return { rules: season, source: 'season' }
  return { rules: null, source: 'none' }
}
