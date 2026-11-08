import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asPlayingTimeRules,
  DEFAULT_PLAYING_TIME_RULES,
  inheritedRules,
  PLAYING_TIME_RANGES,
  PLAYING_TIME_RULE_KEYS,
  type PlayingTimeRuleKey,
  type PlayingTimeRules,
  ruleRowEnabled
} from './playingTimeRules'

const rules = (changes: Partial<PlayingTimeRules> = {}): PlayingTimeRules => ({
  ...DEFAULT_PLAYING_TIME_RULES,
  ...changes
})

const refusal = (raw: unknown): string => {
  try {
    asPlayingTimeRules(raw)
  } catch (error) {
    expect(error).instanceOf(TypeError)
    return (error as TypeError).message
  }
  throw new Error(`Accepted ${JSON.stringify(raw)}`)
}

describe('Playing Time Rules model', function () {
  it('starts every rule off, at the values the issue gives', function () {
    expect(DEFAULT_PLAYING_TIME_RULES).deep.equals({
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
      infieldPositions: ['P', 'C', '1B', '2B', 'SS', '3B'],
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
    })
    expect(PLAYING_TIME_RULE_KEYS).has.length(39)
  })

  it('fills every missing rule with its default, and drops unknown keys', function () {
    expect(asPlayingTimeRules({})).deep.equals(DEFAULT_PLAYING_TIME_RULES)
    const cleaned = asPlayingTimeRules({
      mandatoryPlay: true,
      defensiveOutsRequired: 9,
      largeRosterPlayers: null,
      retired: 'gone'
    })
    expect(cleaned).deep.equals(
      rules({ mandatoryPlay: true, defensiveOutsRequired: 9 })
    )
    // A filled list is its own copy, never the defaults' array.
    cleaned.infieldPositions.pop()
    expect(DEFAULT_PLAYING_TIME_RULES.infieldPositions).has.length(6)
  })

  it('keeps a full set as it was sent', function () {
    const full = rules({
      mandatoryPlay: true,
      defensiveOutsRequired: 3,
      reducedForLargeRosters: true,
      largeRosterPlayers: 25,
      largeRosterOuts: 9,
      applyInShortenedGames: 'never',
      minimumFullInnings: 6,
      minimumInningsBy: 3,
      countPartialInnings: 'fullOnly',
      infieldInningsRequired: 4,
      infieldPositions: ['C', 'SS'],
      catcherCountsAsInfield: 'largeRoster',
      infieldBy: 4,
      outfieldInningsRequired: 3,
      outfieldBy: 5,
      equalSittingOrder: 'off',
      maxSitsPerGame: 0,
      maxInningsPerPosition: 'unlimited',
      rotateEvery: 2,
      catcherMaxInnings: 3
    })
    expect(asPlayingTimeRules(JSON.parse(JSON.stringify(full)))).deep.equals(
      full
    )
  })

  it('keeps each infield position once, in the field’s order', function () {
    expect(
      asPlayingTimeRules({ infieldPositions: ['3B', 'P', '3B', 'C'] })
        .infieldPositions
    ).deep.equals(['P', 'C', '3B'])
    expect(
      asPlayingTimeRules({ infieldPositions: [] }).infieldPositions
    ).deep.equals([])
  })

  it('refuses anything but an object', function () {
    for (const raw of [null, 'rules', 6, [], true])
      expect(refusal(raw)).equals('playingTimeRules: expected an object')
  })

  it('refuses a whole number out of range, or not whole, naming the rule', function () {
    for (const [key, range] of Object.entries(PLAYING_TIME_RANGES)) {
      for (const value of [range.min - 1, range.max + 1, range.min + 0.5, '2'])
        expect(refusal({ [key]: value })).equals(
          `playingTimeRules.${key}: expected a whole number from ${range.min} to ${range.max}`
        )
      expect(
        asPlayingTimeRules({ [key]: range.min })[key as 'maxSitsPerGame']
      ).equals(range.min)
      expect(
        asPlayingTimeRules({ [key]: range.max })[key as 'maxSitsPerGame']
      ).equals(range.max)
    }
    expect(refusal({ maxInningsPerPosition: 'Unlimited' })).contains(
      'maxInningsPerPosition'
    )
  })

  it('refuses a choice the rule does not offer, naming the rule', function () {
    const offers: Array<[PlayingTimeRuleKey, unknown, string]> = [
      ['defensiveOutsRequired', 5, '3, 6, 9'],
      ['largeRosterOuts', '3', '3, 6, 9'],
      ['applyInShortenedGames', 'sometimes', 'always, localOption, never'],
      ['minimumInningsBy', 6, '3, 4, 5, end'],
      ['countPartialInnings', 'half', 'fullOnly, anyAppearance'],
      ['catcherCountsAsInfield', true, 'off, always, largeRoster'],
      ['infieldBy', 'End', '3, 4, 5, end'],
      ['outfieldBy', 2, '3, 4, 5, end'],
      ['equalSittingOrder', 'never', 'secondAfterAll, thirdAfterAll, off'],
      ['rotateEvery', 3, '0, 1, 2'],
      ['catcherMaxInnings', 5, '3, 4'],
      ['infieldPositions', ['P', 'LF'], 'P, C, 1B, 2B, SS, 3B']
    ]
    for (const [key, value, choices] of offers)
      expect(refusal({ [key]: value })).equals(
        `playingTimeRules.${key}: expected one of ${choices}`
      )
    expect(refusal({ infieldPositions: 'P' })).equals(
      'playingTimeRules.infieldPositions: expected a list of positions'
    )
  })

  it('refuses a toggle that is not a boolean, naming it', function () {
    const toggles = PLAYING_TIME_RULE_KEYS.filter(
      key => typeof DEFAULT_PLAYING_TIME_RULES[key] === 'boolean'
    )
    expect(toggles).has.length(21)
    for (const key of toggles)
      expect(refusal({ [key]: 'yes' })).equals(
        `playingTimeRules.${key}: expected a boolean`
      )
  })

  describe('rows that depend on another', function () {
    /** Each dependent row, off with the defaults and on with what it needs. */
    const dependents: Array<[PlayingTimeRuleKey, Partial<PlayingTimeRules>]> = [
      ['defensiveOutsRequired', { mandatoryPlay: true }],
      ['mustBeConsecutive', { mandatoryPlay: true }],
      ['reducedForLargeRosters', { mandatoryPlay: true }],
      ['applyInShortenedGames', { mandatoryPlay: true }],
      [
        'largeRosterPlayers',
        { mandatoryPlay: true, reducedForLargeRosters: true }
      ],
      [
        'largeRosterOuts',
        { mandatoryPlay: true, reducedForLargeRosters: true }
      ],
      ['minimumFullInnings', { stricterMinimumInnings: true }],
      ['minimumInningsBy', { stricterMinimumInnings: true }],
      ['countPartialInnings', { stricterMinimumInnings: true }],
      ['infieldInningsRequired', { requireMinimumInfield: true }],
      ['infieldPositions', { requireMinimumInfield: true }],
      ['catcherCountsAsInfield', { requireMinimumInfield: true }],
      ['infieldBy', { requireMinimumInfield: true }],
      ['outfieldInningsRequired', { requireMinimumOutfield: true }],
      ['outfieldBy', { requireMinimumOutfield: true }],
      ['noConsecutiveSits', { enforceSittingLimits: true }],
      ['equalSittingOrder', { enforceSittingLimits: true }],
      ['maxSitsPerGame', { enforceSittingLimits: true }],
      ['startingBatteryExemptFromSitting', { enforceSittingLimits: true }],
      ['maxInningsPerPosition', { limitInningsAtPosition: true }],
      ['rotateEvery', { limitInningsAtPosition: true }],
      ['mustPlayInfieldAndOutfield', { requireMinimumInfield: true }],
      ['mustPlayInfieldAndOutfield', { requireMinimumOutfield: true }],
      ['startingBatteryExemptFromMinimums', { requireMinimumInfield: true }],
      ['startingBatteryExemptFromMinimums', { requireMinimumOutfield: true }],
      ['catcherMaxInnings', { catcherInningLimit: true }],
      ['catcherBlocksIfCatchesFourth', { catcherBlocksPitching: true }],
      ['lateArrivalsToEnd', { continuousBatting: true }],
      ['departuresSkipWithoutOut', { continuousBatting: true }]
    ]

    it('is off while what it depends on is off, and on once it is on', function () {
      for (const [key, needs] of dependents) {
        expect(ruleRowEnabled(rules(), key), key).equals(false)
        expect(ruleRowEnabled(rules(needs), key), key).equals(true)
      }
    })

    it('keeps the large-roster rows off until both of their parents are on', function () {
      for (const key of ['largeRosterPlayers', 'largeRosterOuts'] as const) {
        expect(ruleRowEnabled(rules({ mandatoryPlay: true }), key)).equals(
          false
        )
        expect(
          ruleRowEnabled(rules({ reducedForLargeRosters: true }), key)
        ).equals(false)
      }
    })

    it('never gates a top-level rule', function () {
      const gated = new Set(dependents.map(([key]) => key))
      const free = PLAYING_TIME_RULE_KEYS.filter(key => !gated.has(key))
      expect(free).deep.equals([
        'mandatoryPlay',
        'stricterMinimumInnings',
        'requireMinimumInfield',
        'requireMinimumOutfield',
        'enforceSittingLimits',
        'limitInningsAtPosition',
        'catcherInningLimit',
        'catcherBlocksPitching',
        'continuousBatting',
        'trackSeasonInfieldBalance',
        'rotateLeadoff',
        'mustPlayNextSuggestions'
      ])
      for (const key of free)
        expect(ruleRowEnabled(rules(), key), key).equals(true)
    })
  })

  it('takes the team’s own set, then its season’s, then none', function () {
    const own = rules({ mandatoryPlay: true })
    const season = rules({ continuousBatting: true })
    expect(inheritedRules(own, season)).deep.equals({
      rules: own,
      source: 'team'
    })
    expect(inheritedRules(own, null)).deep.equals({
      rules: own,
      source: 'team'
    })
    expect(inheritedRules(null, season)).deep.equals({
      rules: season,
      source: 'season'
    })
    expect(inheritedRules(null, null)).deep.equals({
      rules: null,
      source: 'none'
    })
  })
})
