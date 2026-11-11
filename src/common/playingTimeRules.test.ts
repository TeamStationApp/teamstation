import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asPlayingTimeRules,
  DEFAULT_PLAYING_TIME_RULES,
  inheritedRules,
  PLAYING_TIME_RULE_KEYS,
  type PlayingTimeRowKey,
  type PlayingTimeRules,
  ruleRowEnabled,
  ruleValue,
  withRuleValue
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

/** The first version's defaults, as it stored every set: all of its keys. */
const FIRST_DEFAULTS = {
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
}

describe('Playing Time Rules model', function () {
  it('starts every rule off, Innings first, 6 outs, no catcher limit or block', function () {
    expect(DEFAULT_PLAYING_TIME_RULES).deep.equals({
      defensivePlayingTime: false,
      measuredIn: 'innings',
      outs: { required: 6, consecutive: false },
      innings: {
        minimum: 2,
        completeBy: 'none',
        countPartial: 'anyAppearance'
      },
      largeRoster: {
        enabled: false,
        players: 15,
        outs: { required: 3, consecutive: false },
        innings: {
          minimum: 1,
          completeBy: 'none',
          countPartial: 'anyAppearance'
        }
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
    })
    expect(PLAYING_TIME_RULE_KEYS).has.length(27)
  })

  it('fills every missing rule and block with its defaults, and drops unknown keys', function () {
    expect(asPlayingTimeRules({})).deep.equals(DEFAULT_PLAYING_TIME_RULES)
    const cleaned = asPlayingTimeRules({
      measuredIn: 'outs',
      outs: { required: 9 },
      largeRoster: { enabled: true, innings: null, retired: 1 },
      maxSitsPerGame: null,
      retired: 'gone'
    })
    expect(cleaned).deep.equals(
      rules({
        measuredIn: 'outs',
        outs: { required: 9, consecutive: false },
        largeRoster: {
          ...DEFAULT_PLAYING_TIME_RULES.largeRoster,
          enabled: true
        }
      })
    )
    // A filled block is its own copy, never the defaults' object.
    expect(cleaned.innings).not.equals(DEFAULT_PLAYING_TIME_RULES.innings)
    expect(cleaned.largeRoster.innings).not.equals(
      DEFAULT_PLAYING_TIME_RULES.largeRoster.innings
    )
  })

  it('keeps a full set as it was sent', function () {
    const full = rules({
      defensivePlayingTime: true,
      measuredIn: 'outs',
      outs: { required: 3, consecutive: true },
      innings: { minimum: 6, completeBy: 3, countPartial: 'fullOnly' },
      largeRoster: {
        enabled: true,
        players: 25,
        outs: { required: 9, consecutive: true },
        innings: { minimum: 4, completeBy: 5, countPartial: 'fullOnly' }
      },
      infieldInningsRequired: 4,
      pitcherCountsAsInfield: false,
      catcherCountsAs: 'outfield',
      infieldBy: 4,
      outfieldInningsRequired: 3,
      outfieldBy: 5,
      equalSittingOrder: 'off',
      maxSitsPerGame: 0,
      maxInningsPerPosition: 'unlimited',
      rotateEvery: 2,
      catcherMaxInnings: 5,
      catcherBlocksPitching: 3
    })
    expect(asPlayingTimeRules(JSON.parse(JSON.stringify(full)))).deep.equals(
      full
    )
  })

  it('refuses anything but an object, a block too', function () {
    for (const raw of [null, 'rules', 6, [], true])
      expect(refusal(raw)).equals('playingTimeRules: expected an object')
    expect(refusal({ outs: 6 })).equals(
      'playingTimeRules.outs: expected an object'
    )
    expect(refusal({ largeRoster: { innings: [] } })).equals(
      'playingTimeRules.largeRoster.innings: expected an object'
    )
  })

  it('refuses a whole number out of range, or not whole, naming the rule', function () {
    const counts: Array<[string, (value: unknown) => object, number, number]> =
      [
        [
          'largeRoster.players',
          value => ({ largeRoster: { players: value } }),
          10,
          25
        ],
        ['innings.minimum', value => ({ innings: { minimum: value } }), 1, 6],
        [
          'largeRoster.innings.minimum',
          value => ({ largeRoster: { innings: { minimum: value } } }),
          1,
          6
        ],
        [
          'infieldInningsRequired',
          value => ({ infieldInningsRequired: value }),
          1,
          4
        ],
        [
          'outfieldInningsRequired',
          value => ({ outfieldInningsRequired: value }),
          1,
          3
        ],
        ['maxSitsPerGame', value => ({ maxSitsPerGame: value }), 0, 3],
        [
          'maxInningsPerPosition',
          value => ({ maxInningsPerPosition: value }),
          2,
          6
        ]
      ]
    for (const [name, raw, min, max] of counts) {
      for (const value of [min - 1, max + 1, min + 0.5, '2'])
        expect(refusal(raw(value))).equals(
          `playingTimeRules.${name}: expected a whole number from ${min} to ${max}`
        )
      for (const value of [min, max])
        expect(
          ruleValue(asPlayingTimeRules(raw(value)), name as PlayingTimeRowKey)
        ).equals(value)
    }
    expect(refusal({ maxInningsPerPosition: 'Unlimited' })).contains(
      'maxInningsPerPosition'
    )
  })

  it('refuses a choice the rule does not offer, naming the rule', function () {
    const offers: Array<[object, string, string]> = [
      [{ measuredIn: 'games' }, 'measuredIn', 'innings, outs'],
      [{ outs: { required: 5 } }, 'outs.required', '3, 6, 9'],
      [
        { largeRoster: { outs: { required: '3' } } },
        'largeRoster.outs.required',
        '3, 6, 9'
      ],
      [
        { innings: { completeBy: 'end' } },
        'innings.completeBy',
        '3, 4, 5, none'
      ],
      [
        { largeRoster: { innings: { completeBy: 6 } } },
        'largeRoster.innings.completeBy',
        '3, 4, 5, none'
      ],
      [
        { innings: { countPartial: 'half' } },
        'innings.countPartial',
        'fullOnly, anyAppearance'
      ],
      [{ catcherCountsAs: 'always' }, 'catcherCountsAs', 'infield, outfield'],
      [{ infieldBy: 'end' }, 'infieldBy', '3, 4, 5, none'],
      [{ outfieldBy: 2 }, 'outfieldBy', '3, 4, 5, none'],
      [
        { equalSittingOrder: 'never' },
        'equalSittingOrder',
        'secondAfterAll, thirdAfterAll, off'
      ],
      [{ rotateEvery: 3 }, 'rotateEvery', '0, 1, 2'],
      [{ catcherMaxInnings: 6 }, 'catcherMaxInnings', '3, 4, 5, none'],
      [
        { measuredIn: 'innings', catcherBlocksPitching: true },
        'catcherBlocksPitching',
        '3, 4, 5, none'
      ]
    ]
    for (const [raw, name, choices] of offers)
      expect(refusal(raw)).equals(
        `playingTimeRules.${name}: expected one of ${choices}`
      )
  })

  it('refuses a toggle that is not a boolean, naming it', function () {
    const toggles = [
      ...PLAYING_TIME_RULE_KEYS.filter(
        key => typeof DEFAULT_PLAYING_TIME_RULES[key] === 'boolean'
      ),
      'outs.consecutive',
      'largeRoster.enabled',
      'largeRoster.outs.consecutive'
    ]
    expect(toggles).has.length(15)
    for (const name of toggles) {
      const raw = name
        .split('.')
        .reduceRight<unknown>((value, part) => ({ [part]: value }), 'yes')
      expect(refusal(raw)).equals(
        `playingTimeRules.${name}: expected a boolean`
      )
    }
  })

  it('reads and changes a row by its key, copying each block it is in', function () {
    const start = rules()
    expect(ruleValue(start, 'largeRoster.outs.required')).equals(3)
    expect(ruleValue(start, 'catcherMaxInnings')).equals('none')
    const changed = withRuleValue(start, 'largeRoster.outs.required', 9)
    expect(changed.largeRoster.outs.required).equals(9)
    expect(changed.largeRoster.innings).equals(start.largeRoster.innings)
    expect(start.largeRoster.outs.required).equals(3)
    expect(changed.largeRoster).not.equals(start.largeRoster)
    expect(withRuleValue(start, 'maxSitsPerGame', 2)).deep.equals(
      rules({ maxSitsPerGame: 2 })
    )
  })

  describe('a stored Must Play Both Infield and Outfield, no longer a rule', function () {
    it('becomes the other minimum, on at 1 inning with no deadline, beside one minimum', function () {
      // Infield on (2 by the 4th), outfield off with values of its own.
      const infield = asPlayingTimeRules({
        requireMinimumInfield: true,
        infieldInningsRequired: 2,
        infieldBy: 4,
        outfieldInningsRequired: 3,
        outfieldBy: 3,
        mustPlayInfieldAndOutfield: true
      })
      expect(infield).deep.include({
        requireMinimumInfield: true,
        infieldInningsRequired: 2,
        infieldBy: 4,
        requireMinimumOutfield: true,
        outfieldInningsRequired: 1,
        outfieldBy: 'none'
      })
      expect(infield).not.have.property('mustPlayInfieldAndOutfield')
      expect(
        asPlayingTimeRules({
          requireMinimumOutfield: true,
          mustPlayInfieldAndOutfield: true
        })
      ).deep.include({
        requireMinimumInfield: true,
        infieldInningsRequired: 1,
        infieldBy: 'none'
      })
    })

    it('changes nothing beside both minimums or neither, or when it was off', function () {
      for (const minimums of [
        { requireMinimumInfield: true, requireMinimumOutfield: true },
        {}
      ])
        for (const mustPlay of [true, false])
          expect(
            asPlayingTimeRules({
              ...minimums,
              mustPlayInfieldAndOutfield: mustPlay
            }),
            JSON.stringify([minimums, mustPlay])
          ).deep.equals(asPlayingTimeRules(minimums))
      expect(
        asPlayingTimeRules({
          requireMinimumInfield: true,
          mustPlayInfieldAndOutfield: false
        }).requireMinimumOutfield
      ).equals(false)
    })

    it('becomes the other minimum in a set the first version stored, too', function () {
      expect(
        asPlayingTimeRules({
          ...FIRST_DEFAULTS,
          requireMinimumInfield: true,
          mustPlayInfieldAndOutfield: true
        })
      ).deep.include({
        requireMinimumOutfield: true,
        outfieldInningsRequired: 1,
        outfieldBy: 'none'
      })
    })
  })

  describe('a set the first version stored', function () {
    /** The first version's set with `changes`, read into this one. */
    const read = (changes: Record<string, unknown> = {}): PlayingTimeRules =>
      asPlayingTimeRules({ ...FIRST_DEFAULTS, ...changes })

    it('reads its defaults as this version’s, with its values carried into both blocks', function () {
      expect(read()).deep.equals(DEFAULT_PLAYING_TIME_RULES)
    })

    it('reads Mandatory Play alone as Defensive Playing Time in outs', function () {
      // Outs 9, consecutive, a large roster of 14 at 3 outs, no P in the
      // infield, the catcher off.
      const outs = read({
        mandatoryPlay: true,
        defensiveOutsRequired: 9,
        mustBeConsecutive: true,
        reducedForLargeRosters: true,
        largeRosterPlayers: 14,
        largeRosterOuts: 3,
        applyInShortenedGames: 'never',
        requireMinimumInfield: true,
        infieldInningsRequired: 2,
        infieldPositions: ['C', '1B', '2B', 'SS', '3B'],
        catcherCountsAsInfield: 'off',
        infieldBy: 4,
        enforceSittingLimits: true,
        maxSitsPerGame: 2,
        trackSeasonInfieldBalance: true,
        rotateLeadoff: true,
        mustPlayNextSuggestions: true
      })
      expect(outs).deep.equals(
        rules({
          defensivePlayingTime: true,
          measuredIn: 'outs',
          outs: { required: 9, consecutive: true },
          innings: {
            minimum: 2,
            completeBy: 'none',
            countPartial: 'anyAppearance'
          },
          largeRoster: {
            enabled: true,
            players: 14,
            outs: { required: 3, consecutive: true },
            innings: {
              minimum: 1,
              completeBy: 'none',
              countPartial: 'anyAppearance'
            }
          },
          requireMinimumInfield: true,
          infieldInningsRequired: 2,
          pitcherCountsAsInfield: false,
          catcherCountsAs: 'outfield',
          infieldBy: 4,
          enforceSittingLimits: true,
          maxSitsPerGame: 2
        })
      )
    })

    it('reads Stricter Minimum Innings alone as Defensive Playing Time in innings', function () {
      // Innings 3 by the 4th, full only, the catcher limited to 3 and
      // blocking pitching.
      const innings = read({
        stricterMinimumInnings: true,
        minimumFullInnings: 3,
        minimumInningsBy: 4,
        countPartialInnings: 'fullOnly',
        largeRosterOuts: 6,
        catcherCountsAsInfield: 'largeRoster',
        outfieldBy: 5,
        catcherInningLimit: true,
        catcherMaxInnings: 3,
        catcherBlocksPitching: true,
        catcherBlocksIfCatchesFourth: true
      })
      expect(innings).deep.equals(
        rules({
          defensivePlayingTime: true,
          measuredIn: 'innings',
          outs: { required: 6, consecutive: false },
          innings: { minimum: 3, completeBy: 4, countPartial: 'fullOnly' },
          largeRoster: {
            enabled: false,
            players: 15,
            outs: { required: 6, consecutive: false },
            // Its outs over 3 is 2, but the first version asked every
            // lineup for 3 innings: no fewer, by the main block's deadline.
            innings: { minimum: 3, completeBy: 4, countPartial: 'fullOnly' }
          },
          catcherCountsAs: 'infield',
          outfieldBy: 5,
          catcherMaxInnings: 3,
          catcherBlocksPitching: 4
        })
      )
    })

    it('reduces only what Mandatory Play asked of a large roster, never Stricter Minimum Innings', function () {
      // A stored large-roster reduction with Mandatory Play off reduced
      // nothing: the large roster stays off.
      const alone = read({
        stricterMinimumInnings: true,
        minimumFullInnings: 3,
        reducedForLargeRosters: true,
        largeRosterOuts: 3
      })
      expect(alone.largeRoster.enabled).equals(false)
      expect(alone.innings.minimum).equals(3)
      // With both on, a 15-player lineup still owes Stricter Minimum
      // Innings' 3, not the reduced outs' 1.
      const both = read({
        mandatoryPlay: true,
        defensiveOutsRequired: 9,
        stricterMinimumInnings: true,
        minimumFullInnings: 3,
        reducedForLargeRosters: true,
        largeRosterOuts: 3
      })
      expect(both.largeRoster.enabled).equals(true)
      expect(both.largeRoster.innings.minimum).equals(3)
      expect(both.innings.minimum).equals(3)
      // Mandatory Play's reduction alone still reduces, in innings too.
      expect(
        read({
          mandatoryPlay: true,
          reducedForLargeRosters: true,
          largeRosterOuts: 3
        }).largeRoster
      ).deep.include({ enabled: true })
    })

    it('keeps the stricter minimum when both were on', function () {
      const both = (outs: number, innings: number): number =>
        read({
          mandatoryPlay: true,
          defensiveOutsRequired: outs,
          stricterMinimumInnings: true,
          minimumFullInnings: innings
        }).innings.minimum
      expect(both(9, 2)).equals(3)
      expect(both(6, 4)).equals(4)
      expect(read({ mandatoryPlay: true, stricterMinimumInnings: true }))
        .property('measuredIn')
        .equals('innings')
      // A catcher limit that was off keeps no limit.
      expect(read({ catcherMaxInnings: 3 }).catcherMaxInnings).equals('none')
    })

    it('reads a set with any of its own keys, and only without measuredIn', function () {
      expect(asPlayingTimeRules({ mandatoryPlay: true })).deep.include({
        defensivePlayingTime: true,
        measuredIn: 'outs'
      })
      expect(
        asPlayingTimeRules({ catcherBlocksPitching: true })
          .catcherBlocksPitching
      ).equals(4)
      expect(asPlayingTimeRules({ rotateLeadoff: true })).deep.equals(
        DEFAULT_PLAYING_TIME_RULES
      )
      // With measuredIn, its keys are unknown ones, dropped.
      expect(
        asPlayingTimeRules({ measuredIn: 'outs', mandatoryPlay: true })
      ).deep.equals(rules({ measuredIn: 'outs' }))
    })

    it('refuses its own values out of range, naming its rule', function () {
      expect(refusal({ mandatoryPlay: 'yes' })).equals(
        'playingTimeRules.mandatoryPlay: expected a boolean'
      )
      expect(refusal({ defensiveOutsRequired: 5 })).equals(
        'playingTimeRules.defensiveOutsRequired: expected one of 3, 6, 9'
      )
      expect(refusal({ minimumInningsBy: 'none' })).equals(
        'playingTimeRules.minimumInningsBy: expected one of 3, 4, 5, end'
      )
      expect(refusal({ infieldPositions: 'P' })).equals(
        'playingTimeRules.infieldPositions: expected a list of positions'
      )
      expect(refusal({ catcherCountsAsInfield: true })).equals(
        'playingTimeRules.catcherCountsAsInfield: expected one of off, always, largeRoster'
      )
      expect(
        refusal({ catcherInningLimit: true, catcherMaxInnings: 5 })
      ).equals('playingTimeRules.catcherMaxInnings: expected one of 3, 4')
      // A value both versions share is this version's to refuse.
      expect(refusal({ mandatoryPlay: true, maxSitsPerGame: 9 })).equals(
        'playingTimeRules.maxSitsPerGame: expected a whole number from 0 to 3'
      )
    })
  })

  describe('rows that depend on another', function () {
    const on = { defensivePlayingTime: true }
    const outs = { ...on, measuredIn: 'outs' as const }
    const large = { enabled: true, players: 15 }
    const largeOuts = {
      ...outs,
      largeRoster: { ...DEFAULT_PLAYING_TIME_RULES.largeRoster, ...large }
    }
    const largeInnings = {
      ...on,
      largeRoster: { ...DEFAULT_PLAYING_TIME_RULES.largeRoster, ...large }
    }
    /** Each dependent row, off with the defaults and on with what it needs. */
    const dependents: Array<[PlayingTimeRowKey, Partial<PlayingTimeRules>]> = [
      ['measuredIn', on],
      ['outs.required', outs],
      ['outs.consecutive', outs],
      ['innings.minimum', on],
      ['innings.completeBy', on],
      ['innings.countPartial', on],
      ['largeRoster.enabled', on],
      ['largeRoster.players', largeInnings],
      ['largeRoster.outs.required', largeOuts],
      ['largeRoster.outs.consecutive', largeOuts],
      ['largeRoster.innings.minimum', largeInnings],
      ['largeRoster.innings.completeBy', largeInnings],
      ['largeRoster.innings.countPartial', largeInnings],
      ['infieldInningsRequired', { requireMinimumInfield: true }],
      ['pitcherCountsAsInfield', { requireMinimumInfield: true }],
      ['catcherCountsAs', { requireMinimumInfield: true }],
      ['catcherCountsAs', { requireMinimumOutfield: true }],
      ['infieldBy', { requireMinimumInfield: true }],
      ['outfieldInningsRequired', { requireMinimumOutfield: true }],
      ['outfieldBy', { requireMinimumOutfield: true }],
      ['startingBatteryExemptFromMinimums', { requireMinimumInfield: true }],
      ['startingBatteryExemptFromMinimums', { requireMinimumOutfield: true }],
      ['noConsecutiveSits', { enforceSittingLimits: true }],
      ['equalSittingOrder', { enforceSittingLimits: true }],
      ['maxSitsPerGame', { enforceSittingLimits: true }],
      ['startingBatteryExemptFromSitting', { enforceSittingLimits: true }],
      ['maxInningsPerPosition', { limitInningsAtPosition: true }],
      ['rotateEvery', { limitInningsAtPosition: true }],
      ['lateArrivalsToEnd', { continuousBatting: true }],
      ['departuresSkipWithoutOut', { continuousBatting: true }]
    ]

    it('is off while what it depends on is off, and on once it is on', function () {
      for (const [key, needs] of dependents) {
        expect(ruleRowEnabled(rules(), key), key).equals(false)
        expect(ruleRowEnabled(rules(needs), key), key).equals(true)
      }
    })

    it('shows only the rows of the unit the time is measured in', function () {
      for (const key of ['outs.required', 'outs.consecutive'] as const) {
        expect(ruleRowEnabled(rules(on), key), key).equals(false)
        expect(ruleRowEnabled(rules(outs), key), key).equals(true)
      }
      for (const key of [
        'innings.minimum',
        'innings.completeBy',
        'innings.countPartial'
      ] as const) {
        expect(ruleRowEnabled(rules(on), key), key).equals(true)
        expect(ruleRowEnabled(rules(outs), key), key).equals(false)
      }
      expect(
        ruleRowEnabled(rules(largeInnings), 'largeRoster.outs.required')
      ).equals(false)
      expect(
        ruleRowEnabled(rules(largeOuts), 'largeRoster.innings.minimum')
      ).equals(false)
      // The player count is either unit's.
      expect(ruleRowEnabled(rules(largeOuts), 'largeRoster.players')).equals(
        true
      )
    })

    it('keeps the large-roster rows off until both of their parents are on', function () {
      const keys = [
        'largeRoster.players',
        'largeRoster.innings.minimum',
        'largeRoster.outs.required'
      ] as const
      for (const key of keys) {
        expect(ruleRowEnabled(rules(outs), key), key).equals(false)
        expect(
          ruleRowEnabled(
            rules({
              measuredIn: 'outs',
              largeRoster: {
                ...DEFAULT_PLAYING_TIME_RULES.largeRoster,
                enabled: true
              }
            }),
            key
          ),
          key
        ).equals(false)
      }
    })

    it('never gates a top-level rule', function () {
      const gated = new Set<string>(dependents.map(([key]) => key))
      const free = PLAYING_TIME_RULE_KEYS.filter(
        key =>
          !gated.has(key) && typeof DEFAULT_PLAYING_TIME_RULES[key] !== 'object'
      )
      expect(free).deep.equals([
        'defensivePlayingTime',
        'requireMinimumInfield',
        'requireMinimumOutfield',
        'enforceSittingLimits',
        'limitInningsAtPosition',
        'catcherMaxInnings',
        'catcherBlocksPitching',
        'continuousBatting'
      ])
      for (const key of free)
        expect(ruleRowEnabled(rules(), key as PlayingTimeRowKey), key).equals(
          true
        )
    })
  })

  it('takes the team’s own set, then its season’s, then none', function () {
    const own = rules({ defensivePlayingTime: true })
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
