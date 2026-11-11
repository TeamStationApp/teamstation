import type { Cleaner } from 'cleaners'

/** By which inning a requirement must be met: a number, or none (the end). */
export const INNING_DEADLINES = [3, 4, 5, 'none'] as const
export type InningDeadline = (typeof INNING_DEADLINES)[number]

/** The defensive outs a player must play, and a large roster's. */
export const DEFENSIVE_OUTS = [3, 6, 9] as const
export type DefensiveOuts = (typeof DEFENSIVE_OUTS)[number]

/** What Defensive Playing Time is measured in: Innings is the left option. */
export const MEASURED_IN_CHOICES = ['innings', 'outs'] as const
export const PARTIAL_INNING_CHOICES = ['fullOnly', 'anyAppearance'] as const
export const CATCHER_COUNTS_AS_CHOICES = ['infield', 'outfield'] as const
export const SITTING_ORDER_CHOICES = [
  'secondAfterAll',
  'thirdAfterAll',
  'off'
] as const
/** Rotate Every N Innings: 0 is Off. */
export const ROTATE_EVERY_CHOICES = [0, 1, 2] as const
/** Catcher Inning Limit, and Catching Blocks Pitching: 'none' is off. */
export const CATCHER_INNING_CHOICES = [3, 4, 5, 'none'] as const
export type CatcherInnings = (typeof CATCHER_INNING_CHOICES)[number]

/** Defensive Playing Time measured in outs. */
export interface OutsRequirement {
  required: DefensiveOuts
  consecutive: boolean
}

/** Defensive Playing Time measured in innings. */
export interface InningsRequirement {
  /** Minimum Full Innings. */
  minimum: number
  completeBy: InningDeadline
  /** Stored and shown; a plan counts whole innings. */
  countPartial: (typeof PARTIAL_INNING_CHOICES)[number]
}

/**
 * A season's or a team's Playing Time Rules: what a coach's game plan is
 * warned against. Nothing here blocks a plan; every enabled rule warns.
 */
export interface PlayingTimeRules {
  /** "Require Defensive Playing Time". */
  defensivePlayingTime: boolean
  measuredIn: (typeof MEASURED_IN_CHOICES)[number]
  outs: OutsRequirement
  innings: InningsRequirement
  /** The requirement when "≥ `players` players present", in either unit. */
  largeRoster: {
    enabled: boolean
    players: number
    outs: OutsRequirement
    innings: InningsRequirement
  }
  requireMinimumInfield: boolean
  infieldInningsRequired: number
  /** 1B, 2B, SS and 3B are always infield; P is when this is on. */
  pitcherCountsAsInfield: boolean
  /** Which minimum the catcher's innings count toward. */
  catcherCountsAs: (typeof CATCHER_COUNTS_AS_CHOICES)[number]
  infieldBy: InningDeadline
  requireMinimumOutfield: boolean
  outfieldInningsRequired: number
  outfieldBy: InningDeadline
  startingBatteryExemptFromMinimums: boolean
  enforceSittingLimits: boolean
  noConsecutiveSits: boolean
  equalSittingOrder: (typeof SITTING_ORDER_CHOICES)[number]
  maxSitsPerGame: number
  startingBatteryExemptFromSitting: boolean
  limitInningsAtPosition: boolean
  maxInningsPerPosition: number | 'unlimited'
  rotateEvery: (typeof ROTATE_EVERY_CHOICES)[number]
  /** The most innings a player may catch; 'none' is no limit. */
  catcherMaxInnings: CatcherInnings
  /**
   * After this many innings catching, no pitching that calendar day;
   * 'none' ("Disable") is off.
   */
  catcherBlocksPitching: CatcherInnings
  continuousBatting: boolean
  lateArrivalsToEnd: boolean
  departuresSkipWithoutOut: boolean
}

export type PlayingTimeRuleKey = keyof PlayingTimeRules

/**
 * What each row of the rules screen holds, by its key: a top-level rule's
 * own key, and a nested one's path ("largeRoster.outs.required").
 */
export interface PlayingTimeRowValues extends Omit<
  PlayingTimeRules,
  'outs' | 'innings' | 'largeRoster'
> {
  'outs.required': DefensiveOuts
  'outs.consecutive': boolean
  'innings.minimum': number
  'innings.completeBy': InningDeadline
  'innings.countPartial': InningsRequirement['countPartial']
  'largeRoster.enabled': boolean
  'largeRoster.players': number
  'largeRoster.outs.required': DefensiveOuts
  'largeRoster.outs.consecutive': boolean
  'largeRoster.innings.minimum': number
  'largeRoster.innings.completeBy': InningDeadline
  'largeRoster.innings.countPartial': InningsRequirement['countPartial']
}

export type PlayingTimeRowKey = keyof PlayingTimeRowValues

/** Every rule off, and each value where the rule starts once it is on. */
export const DEFAULT_PLAYING_TIME_RULES: PlayingTimeRules = {
  defensivePlayingTime: false,
  measuredIn: 'innings',
  outs: { required: 6, consecutive: false },
  innings: { minimum: 2, completeBy: 'none', countPartial: 'anyAppearance' },
  largeRoster: {
    enabled: false,
    players: 15,
    outs: { required: 3, consecutive: false },
    innings: { minimum: 1, completeBy: 'none', countPartial: 'anyAppearance' }
  },
  requireMinimumInfield: false,
  infieldInningsRequired: 1,
  pitcherCountsAsInfield: true,
  catcherCountsAs: 'infield',
  infieldBy: 'none',
  requireMinimumOutfield: false,
  outfieldInningsRequired: 1,
  outfieldBy: 'none',
  startingBatteryExemptFromMinimums: true,
  enforceSittingLimits: false,
  noConsecutiveSits: true,
  equalSittingOrder: 'secondAfterAll',
  maxSitsPerGame: 1,
  startingBatteryExemptFromSitting: true,
  limitInningsAtPosition: false,
  maxInningsPerPosition: 3,
  rotateEvery: 0,
  catcherMaxInnings: 'none',
  catcherBlocksPitching: 'none',
  continuousBatting: false,
  lateArrivalsToEnd: false,
  departuresSkipWithoutOut: false
}

export const PLAYING_TIME_RULE_KEYS = Object.keys(
  DEFAULT_PLAYING_TIME_RULES
) as PlayingTimeRuleKey[]

/** The whole-number rules' ends, where their steppers stop. */
export const PLAYING_TIME_RANGES = {
  largeRosterPlayers: { min: 10, max: 25 },
  /** Minimum Full Innings, a large roster's too. */
  minimumInnings: { min: 1, max: 6 },
  infieldInningsRequired: { min: 1, max: 4 },
  outfieldInningsRequired: { min: 1, max: 3 },
  maxSitsPerGame: { min: 0, max: 3 },
  /** Above these is Unlimited. */
  maxInningsPerPosition: { min: 2, max: 6 }
} as const

/** A row's value: `ruleValue(rules, 'largeRoster.outs.required')`. */
export function ruleValue<Key extends PlayingTimeRowKey>(
  rules: PlayingTimeRules,
  key: Key
): PlayingTimeRowValues[Key] {
  return key
    .split('.')
    .reduce<unknown>(
      (at, part) => (at as Record<string, unknown>)[part],
      rules
    ) as PlayingTimeRowValues[Key]
}

/** The rules with one row's value changed, each block it is in copied. */
export function withRuleValue<Key extends PlayingTimeRowKey>(
  rules: PlayingTimeRules,
  key: Key,
  value: PlayingTimeRowValues[Key]
): PlayingTimeRules {
  const put = (
    at: Record<string, unknown>,
    [part, ...rest]: string[]
  ): Record<string, unknown> => ({
    ...at,
    [part]:
      rest.length === 0 ? value : put(at[part] as Record<string, unknown>, rest)
  })
  return put(
    rules as unknown as Record<string, unknown>,
    key.split('.')
  ) as unknown as PlayingTimeRules
}

function refused(name: string, expected: string): TypeError {
  return new TypeError(`playingTimeRules.${name}: expected ${expected}`)
}

const toggle =
  (name: string): Cleaner<boolean> =>
  raw => {
    if (typeof raw !== 'boolean') throw refused(name, 'a boolean')
    return raw
  }

function choice<const T extends ReadonlyArray<string | number>>(
  name: string,
  values: T
): Cleaner<T[number]> {
  return raw => {
    if (!values.includes(raw as T[number]))
      throw refused(name, `one of ${values.join(', ')}`)
    return raw as T[number]
  }
}

const count =
  (
    name: string,
    { min, max }: { readonly min: number; readonly max: number }
  ): Cleaner<number> =>
  raw => {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < min ||
      raw > max
    )
      throw refused(name, `a whole number from ${min} to ${max}`)
    return raw
  }

/**
 * An object of `defaults`' keys, each cleaned by its own cleaner: a missing
 * or null key takes its default (a block or a list, a fresh copy of it),
 * and an unknown one is dropped. `name` is the object's place in the rules,
 * null for the whole set.
 */
function fields<T extends object>(
  name: string | null,
  cleaners: { [Key in keyof T]: Cleaner<T[Key]> },
  defaults: T
): Cleaner<T> {
  return raw => {
    if (typeof raw !== 'object' || raw == null || Array.isArray(raw))
      throw name == null
        ? new TypeError('playingTimeRules: expected an object')
        : refused(name, 'an object')
    const given = raw as Record<string, unknown>
    const cleaned: Record<string, unknown> = {}
    for (const key of Object.keys(defaults) as Array<keyof T & string>) {
      const value = given[key]
      const fallback = defaults[key]
      cleaned[key] =
        value != null
          ? cleaners[key](value)
          : Array.isArray(fallback)
            ? [...fallback]
            : typeof fallback === 'object' && fallback != null
              ? cleaners[key]({})
              : fallback
    }
    return cleaned as T
  }
}

const outsRequirement = (
  name: string,
  defaults: OutsRequirement
): Cleaner<OutsRequirement> =>
  fields(
    name,
    {
      required: choice(`${name}.required`, DEFENSIVE_OUTS),
      consecutive: toggle(`${name}.consecutive`)
    },
    defaults
  )

const inningsRequirement = (
  name: string,
  defaults: InningsRequirement
): Cleaner<InningsRequirement> =>
  fields(
    name,
    {
      minimum: count(`${name}.minimum`, PLAYING_TIME_RANGES.minimumInnings),
      completeBy: choice(`${name}.completeBy`, INNING_DEADLINES),
      countPartial: choice(`${name}.countPartial`, PARTIAL_INNING_CHOICES)
    },
    defaults
  )

const DEFAULT_LARGE_ROSTER = DEFAULT_PLAYING_TIME_RULES.largeRoster

const cleanRules: Cleaner<PlayingTimeRules> = fields<PlayingTimeRules>(
  null,
  {
    defensivePlayingTime: toggle('defensivePlayingTime'),
    measuredIn: choice('measuredIn', MEASURED_IN_CHOICES),
    outs: outsRequirement('outs', DEFAULT_PLAYING_TIME_RULES.outs),
    innings: inningsRequirement('innings', DEFAULT_PLAYING_TIME_RULES.innings),
    largeRoster: fields(
      'largeRoster',
      {
        enabled: toggle('largeRoster.enabled'),
        players: count(
          'largeRoster.players',
          PLAYING_TIME_RANGES.largeRosterPlayers
        ),
        outs: outsRequirement('largeRoster.outs', DEFAULT_LARGE_ROSTER.outs),
        innings: inningsRequirement(
          'largeRoster.innings',
          DEFAULT_LARGE_ROSTER.innings
        )
      },
      DEFAULT_LARGE_ROSTER
    ),
    requireMinimumInfield: toggle('requireMinimumInfield'),
    infieldInningsRequired: count(
      'infieldInningsRequired',
      PLAYING_TIME_RANGES.infieldInningsRequired
    ),
    pitcherCountsAsInfield: toggle('pitcherCountsAsInfield'),
    catcherCountsAs: choice('catcherCountsAs', CATCHER_COUNTS_AS_CHOICES),
    infieldBy: choice('infieldBy', INNING_DEADLINES),
    requireMinimumOutfield: toggle('requireMinimumOutfield'),
    outfieldInningsRequired: count(
      'outfieldInningsRequired',
      PLAYING_TIME_RANGES.outfieldInningsRequired
    ),
    outfieldBy: choice('outfieldBy', INNING_DEADLINES),
    startingBatteryExemptFromMinimums: toggle(
      'startingBatteryExemptFromMinimums'
    ),
    enforceSittingLimits: toggle('enforceSittingLimits'),
    noConsecutiveSits: toggle('noConsecutiveSits'),
    equalSittingOrder: choice('equalSittingOrder', SITTING_ORDER_CHOICES),
    maxSitsPerGame: count('maxSitsPerGame', PLAYING_TIME_RANGES.maxSitsPerGame),
    startingBatteryExemptFromSitting: toggle(
      'startingBatteryExemptFromSitting'
    ),
    limitInningsAtPosition: toggle('limitInningsAtPosition'),
    maxInningsPerPosition: raw =>
      raw === 'unlimited'
        ? raw
        : count(
            'maxInningsPerPosition',
            PLAYING_TIME_RANGES.maxInningsPerPosition
          )(raw),
    rotateEvery: choice('rotateEvery', ROTATE_EVERY_CHOICES),
    catcherMaxInnings: choice('catcherMaxInnings', CATCHER_INNING_CHOICES),
    catcherBlocksPitching: choice(
      'catcherBlocksPitching',
      CATCHER_INNING_CHOICES
    ),
    continuousBatting: toggle('continuousBatting'),
    lateArrivalsToEnd: toggle('lateArrivalsToEnd'),
    departuresSkipWithoutOut: toggle('departuresSkipWithoutOut')
  },
  DEFAULT_PLAYING_TIME_RULES
)

/** A deadline as the first rules stored it: a number, or the game's end. */
const LEGACY_DEADLINES = [3, 4, 5, 'end'] as const

/**
 * The rules the first version stored that it does not share with this one,
 * as it stored them, with its defaults. The rest (the sitting, position and
 * batting rules, the minimums' toggles and counts) have one shape in both.
 */
const cleanLegacy = fields<{
  mandatoryPlay: boolean
  defensiveOutsRequired: DefensiveOuts
  mustBeConsecutive: boolean
  reducedForLargeRosters: boolean
  largeRosterPlayers: number
  largeRosterOuts: DefensiveOuts
  stricterMinimumInnings: boolean
  minimumFullInnings: number
  minimumInningsBy: (typeof LEGACY_DEADLINES)[number]
  countPartialInnings: InningsRequirement['countPartial']
  infieldPositions: string[]
  catcherCountsAsInfield: 'off' | 'always' | 'largeRoster'
  infieldBy: (typeof LEGACY_DEADLINES)[number]
  outfieldBy: (typeof LEGACY_DEADLINES)[number]
  catcherInningLimit: boolean
  catcherMaxInnings: 3 | 4
  catcherBlocksPitching: boolean
}>(
  null,
  {
    mandatoryPlay: toggle('mandatoryPlay'),
    defensiveOutsRequired: choice('defensiveOutsRequired', DEFENSIVE_OUTS),
    mustBeConsecutive: toggle('mustBeConsecutive'),
    reducedForLargeRosters: toggle('reducedForLargeRosters'),
    largeRosterPlayers: count(
      'largeRosterPlayers',
      PLAYING_TIME_RANGES.largeRosterPlayers
    ),
    largeRosterOuts: choice('largeRosterOuts', DEFENSIVE_OUTS),
    stricterMinimumInnings: toggle('stricterMinimumInnings'),
    minimumFullInnings: count(
      'minimumFullInnings',
      PLAYING_TIME_RANGES.minimumInnings
    ),
    minimumInningsBy: choice('minimumInningsBy', LEGACY_DEADLINES),
    countPartialInnings: choice('countPartialInnings', PARTIAL_INNING_CHOICES),
    infieldPositions: (raw): string[] => {
      if (!Array.isArray(raw) || raw.some(one => typeof one !== 'string'))
        throw refused('infieldPositions', 'a list of positions')
      return raw as string[]
    },
    catcherCountsAsInfield: choice('catcherCountsAsInfield', [
      'off',
      'always',
      'largeRoster'
    ]),
    infieldBy: choice('infieldBy', LEGACY_DEADLINES),
    outfieldBy: choice('outfieldBy', LEGACY_DEADLINES),
    catcherInningLimit: toggle('catcherInningLimit'),
    catcherMaxInnings: choice('catcherMaxInnings', [3, 4]),
    catcherBlocksPitching: toggle('catcherBlocksPitching')
  },
  {
    mandatoryPlay: false,
    defensiveOutsRequired: 6,
    mustBeConsecutive: false,
    reducedForLargeRosters: false,
    largeRosterPlayers: 15,
    largeRosterOuts: 3,
    stricterMinimumInnings: false,
    minimumFullInnings: 2,
    minimumInningsBy: 'end',
    countPartialInnings: 'anyAppearance',
    infieldPositions: ['P', 'C', '1B', '2B', 'SS', '3B'],
    catcherCountsAsInfield: 'always',
    infieldBy: 'end',
    outfieldBy: 'end',
    catcherInningLimit: false,
    catcherMaxInnings: 4,
    catcherBlocksPitching: false
  }
)

/** Keys only the first version's rules have. */
const LEGACY_KEYS = [
  'mandatoryPlay',
  'defensiveOutsRequired',
  'mustBeConsecutive',
  'reducedForLargeRosters',
  'largeRosterPlayers',
  'largeRosterOuts',
  'applyInShortenedGames',
  'stricterMinimumInnings',
  'minimumFullInnings',
  'minimumInningsBy',
  'countPartialInnings',
  'infieldPositions',
  'catcherCountsAsInfield',
  'catcherInningLimit',
  'catcherBlocksIfCatchesFourth',
  'trackSeasonInfieldBalance',
  'rotateLeadoff',
  'mustPlayNextSuggestions'
]

/**
 * Whether a set was stored by the first version of the rules: it has no
 * `measuredIn`, and has one of that version's own keys, or its on/off
 * Catcher Blocks Pitching.
 */
const isLegacy = (given: Record<string, unknown>): boolean =>
  given.measuredIn == null &&
  (LEGACY_KEYS.some(key => given[key] != null) ||
    typeof given.catcherBlocksPitching === 'boolean')

/**
 * A first-version set in this version's shape, still to be cleaned.
 * Mandatory Play's outs and Stricter Minimum Innings become one Defensive
 * Playing Time: in outs with only the first, in innings with the second
 * (keeping the stricter minimum when both were on), and off with neither,
 * with their values kept in both blocks. The large roster's reduction was
 * Mandatory Play's alone: it is on only where Mandatory Play was, and its
 * innings are its outs over 3, by the main block's deadline, but never fewer
 * than Stricter Minimum Innings asked of every lineup when that was on. The infield positions keep only
 * whether P was one; a catcher who counted as infield (always, or above 12
 * players) is infield, and one who did not is outfield. A game-end deadline
 * is none; a catcher limit that was off is none, and the catcher's block on
 * pitching is 4 innings when it was on. Apply in Shortened Games, the fourth
 * inning's block and the season-tracking rules are dropped.
 */
function fromLegacy(given: Record<string, unknown>): Record<string, unknown> {
  const old = cleanLegacy(given)
  const deadline = (by: (typeof LEGACY_DEADLINES)[number]): InningDeadline =>
    by === 'end' ? 'none' : by
  const both = old.mandatoryPlay && old.stricterMinimumInnings
  const innings: InningsRequirement = {
    minimum: both
      ? Math.max(
          old.minimumFullInnings,
          Math.ceil(old.defensiveOutsRequired / 3)
        )
      : old.minimumFullInnings,
    completeBy: deadline(old.minimumInningsBy),
    countPartial: old.countPartialInnings
  }
  return {
    ...given,
    defensivePlayingTime: old.mandatoryPlay || old.stricterMinimumInnings,
    measuredIn:
      old.mandatoryPlay && !old.stricterMinimumInnings ? 'outs' : 'innings',
    outs: {
      required: old.defensiveOutsRequired,
      consecutive: old.mustBeConsecutive
    },
    innings,
    largeRoster: {
      enabled: old.mandatoryPlay && old.reducedForLargeRosters,
      players: old.largeRosterPlayers,
      outs: {
        required: old.largeRosterOuts,
        consecutive: old.mustBeConsecutive
      },
      innings: {
        ...innings,
        minimum: old.stricterMinimumInnings
          ? Math.max(old.minimumFullInnings, Math.ceil(old.largeRosterOuts / 3))
          : Math.ceil(old.largeRosterOuts / 3)
      }
    },
    pitcherCountsAsInfield: old.infieldPositions.includes('P'),
    catcherCountsAs:
      old.catcherCountsAsInfield === 'off' ? 'outfield' : 'infield',
    infieldBy: deadline(old.infieldBy),
    outfieldBy: deadline(old.outfieldBy),
    catcherMaxInnings: old.catcherInningLimit ? old.catcherMaxInnings : 'none',
    catcherBlocksPitching: old.catcherBlocksPitching ? 4 : 'none'
  }
}

/**
 * A whole set of rules. A missing key takes its default, so a set stored
 * before a rule existed still reads; a value out of range, or not one of a
 * rule's choices, is a `TypeError` naming the rule. Unknown keys are dropped.
 * A set the first version stored (`isLegacy`) is read into this shape
 * (`fromLegacy`), and either version's Must Play Both Infield and Outfield
 * becomes the minimum it amounted to (`withMustPlayBoth`).
 */
export function asPlayingTimeRules(raw: unknown): PlayingTimeRules {
  const legacy =
    typeof raw === 'object' &&
    raw != null &&
    !Array.isArray(raw) &&
    isLegacy(raw as Record<string, unknown>)
  return withMustPlayBoth(
    raw as Record<string, unknown>,
    cleanRules(legacy ? fromLegacy(raw as Record<string, unknown>) : raw)
  )
}

/**
 * A stored set's Must Play Both Infield and Outfield, a rule no longer kept,
 * as the minimum it amounted to. It applied only while one minimum or the
 * other was on, and then asked for an inning on the other side by the
 * game's end: that other minimum, on at 1 inning with no deadline. Beside
 * both minimums it added nothing, and beside neither it did nothing. The
 * same plans pass; only one level differs: the old rule weighed both missing
 * halves against the open innings together, so one open inning short of
 * both was red, where the two minimums, judged apart, are each yellow.
 */
function withMustPlayBoth(
  raw: Record<string, unknown>,
  rules: PlayingTimeRules
): PlayingTimeRules {
  if (
    raw.mustPlayInfieldAndOutfield !== true ||
    rules.requireMinimumInfield === rules.requireMinimumOutfield
  )
    return rules
  return rules.requireMinimumInfield
    ? {
        ...rules,
        requireMinimumOutfield: true,
        outfieldInningsRequired: 1,
        outfieldBy: 'none'
      }
    : {
        ...rules,
        requireMinimumInfield: true,
        infieldInningsRequired: 1,
        infieldBy: 'none'
      }
}

const eitherMinimum = (rules: PlayingTimeRules): boolean =>
  rules.requireMinimumInfield || rules.requireMinimumOutfield
const measured =
  (unit: PlayingTimeRules['measuredIn']) =>
  (rules: PlayingTimeRules): boolean =>
    rules.defensivePlayingTime && rules.measuredIn === unit
const largeRoster =
  (unit?: PlayingTimeRules['measuredIn']) =>
  (rules: PlayingTimeRules): boolean =>
    rules.defensivePlayingTime &&
    rules.largeRoster.enabled &&
    (unit == null || rules.measuredIn === unit)

/** What each dependent row needs to be on before it can be changed. */
const ROW_NEEDS: Partial<
  Record<PlayingTimeRowKey, (rules: PlayingTimeRules) => boolean>
> = {
  measuredIn: rules => rules.defensivePlayingTime,
  'outs.required': measured('outs'),
  'outs.consecutive': measured('outs'),
  'innings.minimum': measured('innings'),
  'innings.completeBy': measured('innings'),
  'innings.countPartial': measured('innings'),
  'largeRoster.enabled': rules => rules.defensivePlayingTime,
  'largeRoster.players': largeRoster(),
  'largeRoster.outs.required': largeRoster('outs'),
  'largeRoster.outs.consecutive': largeRoster('outs'),
  'largeRoster.innings.minimum': largeRoster('innings'),
  'largeRoster.innings.completeBy': largeRoster('innings'),
  'largeRoster.innings.countPartial': largeRoster('innings'),
  infieldInningsRequired: rules => rules.requireMinimumInfield,
  pitcherCountsAsInfield: rules => rules.requireMinimumInfield,
  // The catcher counts toward one minimum or the other.
  catcherCountsAs: eitherMinimum,
  infieldBy: rules => rules.requireMinimumInfield,
  outfieldInningsRequired: rules => rules.requireMinimumOutfield,
  outfieldBy: rules => rules.requireMinimumOutfield,
  startingBatteryExemptFromMinimums: eitherMinimum,
  noConsecutiveSits: rules => rules.enforceSittingLimits,
  equalSittingOrder: rules => rules.enforceSittingLimits,
  maxSitsPerGame: rules => rules.enforceSittingLimits,
  startingBatteryExemptFromSitting: rules => rules.enforceSittingLimits,
  maxInningsPerPosition: rules => rules.limitInningsAtPosition,
  rotateEvery: rules => rules.limitInningsAtPosition,
  lateArrivalsToEnd: rules => rules.continuousBatting,
  departuresSkipWithoutOut: rules => rules.continuousBatting
}

/**
 * Whether a rule's row can be changed, and whether the rule applies: a row
 * that depends on another stays off while that one is off, and a row of
 * the unit Defensive Playing Time is not measured in stays off.
 */
export function ruleRowEnabled(
  rules: PlayingTimeRules,
  key: PlayingTimeRowKey
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
