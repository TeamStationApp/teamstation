import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { LineupPlayer } from './api'
import type { PlanCell } from './gamePlan'
import {
  EMPTY_PLAN_SAME_DAY,
  type PlanWarning,
  planWarnings,
  type PlanWarningsInput,
  warningSummary
} from './planWarnings'
import {
  asPlayingTimeRules,
  DEFAULT_PLAYING_TIME_RULES,
  type InningDeadline,
  type InningsRequirement,
  type OutsRequirement,
  type PlayingTimeRules
} from './playingTimeRules'

const NAMES = [
  'Ruth B',
  'Gehrig L',
  'DiMaggio J',
  'Mantle M',
  'Berra Y',
  'Mays W',
  'Aaron H',
  'Clemente R',
  'Koufax S',
  'Gibson B',
  'Robinson J',
  'Williams T',
  'Musial S',
  'Cobb T',
  'Wagner H'
]
const PLAYERS: LineupPlayer[] = NAMES.map((fullName, at) => ({
  gumboId: at + 1,
  fullName,
  jersey: String(at + 1)
}))
const [RUTH, GEHRIG, DIMAGGIO, MANTLE] = NAMES

const rules = (changes: Partial<PlayingTimeRules> = {}): PlayingTimeRules => ({
  ...DEFAULT_PLAYING_TIME_RULES,
  ...changes
})

/** The warnings for rows in batting order, the first player first. */
function warnings(
  rows: PlanCell[][],
  changes: Partial<PlayingTimeRules> | null,
  extra: Partial<PlanWarningsInput> = {}
): PlanWarning[] {
  return planWarnings({
    plan: {
      enabled: true,
      innings: rows[0].length,
      rows: rows.map((cells, at) => ({ player: PLAYERS[at], cells }))
    },
    rules: changes == null ? null : rules(changes),
    sameDay: EMPTY_PLAN_SAME_DAY,
    ...extra
  })
}

/** Defensive Playing Time in outs. */
const inOuts = (
  required: OutsRequirement['required'],
  consecutive = false
): Partial<PlayingTimeRules> => ({
  defensivePlayingTime: true,
  measuredIn: 'outs',
  outs: { required, consecutive }
})

/** Defensive Playing Time in innings, the default unit. */
const inInnings = (
  minimum: number,
  completeBy: InningDeadline = 'none'
): Partial<PlayingTimeRules> => ({
  defensivePlayingTime: true,
  innings: { minimum, completeBy, countPartial: 'anyAppearance' }
})

/** A large roster from `players` present, with its own requirement. */
const largeRoster = (
  players: number,
  outs: OutsRequirement,
  innings: InningsRequirement
): Pick<PlayingTimeRules, 'largeRoster'> => ({
  largeRoster: { enabled: true, players, outs, innings }
})

/** One rule's warnings, as levels and the players each names. */
const of = (
  list: PlanWarning[],
  rule: PlanWarning['rule']
): Array<Pick<PlanWarning, 'level' | 'players'>> =>
  list
    .filter(warning => warning.rule === rule)
    .map(({ level, players }) => ({ level, players }))

/** One rule's warnings, whole. */
const only = (list: PlanWarning[], rule: PlanWarning['rule']): PlanWarning[] =>
  list.filter(warning => warning.rule === rule)

/**
 * `count` rows that each field one inning of `innings` and sit the rest, in
 * turn, so every inning is planned.
 */
const oneInningEach = (count: number, innings: number): PlanCell[][] =>
  Array.from({ length: count }, (_, at) =>
    Array.from({ length: innings }, (__, inning) =>
      inning === at % innings ? 'LF' : ''
    )
  )

/** The same rows a column later, after an inning not planned yet. */
const afterUnplanned = (rows: PlanCell[][]): PlanCell[][] =>
  rows.map(cells => ['', ...cells])

describe('plan warnings', function () {
  it('warns of two players at one position in an inning, with no rules', function () {
    const list = warnings(
      [
        ['SS', 'SS', ''],
        ['SS', 'LF', ''],
        ['LF', 'SS', '']
      ],
      null
    )
    expect(list).deep.equals([
      {
        rule: 'duplicatePosition',
        level: 'red',
        message: `Two players at SS in inning 1: ${RUTH}, ${GEHRIG}`,
        players: [RUTH, GEHRIG]
      },
      {
        rule: 'duplicatePosition',
        level: 'red',
        message: `Two players at SS in inning 2: ${RUTH}, ${DIMAGGIO}`,
        players: [RUTH, DIMAGGIO]
      }
    ])
    // Blank cells are never a duplicate, so this rule has no yellow.
    expect(warnings([[''], [''], [''], ['']], rules())).deep.equals([])
  })

  it('warns of nothing else while every rule is off', function () {
    expect(
      warnings(
        [
          ['', '', ''],
          ['C', 'C', 'C'],
          ['DH', 'EH', '']
        ],
        {}
      )
    ).deep.equals([])
  })

  describe('Defensive Playing Time in outs', function () {
    it('is red when the outs are out of reach and yellow while unplanned innings could meet them', function () {
      // The fourth inning is not planned yet.
      const list = warnings(
        [
          ['P', 'P', 'P', ''],
          ['', '', '', ''],
          ['', '', 'RF', ''],
          ['', '', '', '']
        ],
        inOuts(6)
      )
      expect(of(list, 'defensivePlayingTime')).deep.equals([
        { level: 'red', players: [GEHRIG, MANTLE] },
        { level: 'yellow', players: [DIMAGGIO] }
      ])
      expect(list.map(warning => warning.message)).deep.equals([
        `Cannot reach 6 defensive outs: ${GEHRIG}, ${MANTLE}`,
        `Not yet 6 defensive outs: ${DIMAGGIO}`
      ])
      // Off, or switched off with its values kept, it says nothing.
      expect(
        warnings([['P', 'P', 'P', '']], {
          ...inOuts(9),
          defensivePlayingTime: false
        })
      ).deep.equals([])
    })

    it('needs consecutive innings when Must Be Consecutive is on', function () {
      // The fifth inning is not planned yet.
      const list = warnings(
        [
          ['LF', '', 'LF', '', ''],
          ['', '', '', 'CF', ''],
          ['RF', 'RF', '', '', '']
        ],
        inOuts(6, true)
      )
      expect(of(list, 'defensivePlayingTime')).deep.equals([
        { level: 'red', players: [RUTH] },
        { level: 'yellow', players: [GEHRIG] }
      ])
      expect(list[0].message).equals(
        `Cannot reach 6 consecutive defensive outs: ${RUTH}`
      )
    })

    it('takes the large roster’s outs from its count of players present, not one fewer', function () {
      const reduced = {
        ...inOuts(9),
        ...largeRoster(
          15,
          { required: 3, consecutive: false },
          DEFAULT_PLAYING_TIME_RULES.largeRoster.innings
        )
      }
      expect(
        of(warnings(oneInningEach(14, 3), reduced), 'defensivePlayingTime')
      ).deep.equals([{ level: 'red', players: NAMES.slice(0, 14) }])
      expect(
        only(warnings(oneInningEach(14, 3), reduced), 'defensivePlayingTime')[0]
          .message
      ).contains('Cannot reach 9 defensive outs')
      expect(
        of(warnings(oneInningEach(15, 3), reduced), 'defensivePlayingTime')
      ).deep.equals([])
      // Its own Must Be Consecutive: two separate innings are not six in a
      // row.
      const consecutive = {
        ...reduced,
        ...largeRoster(
          15,
          { required: 6, consecutive: true },
          DEFAULT_PLAYING_TIME_RULES.largeRoster.innings
        )
      }
      const split = NAMES.map((_, at): PlanCell[] =>
        at === 0 ? ['LF', '', 'LF'] : ['CF', 'CF', '']
      )
      expect(
        of(warnings(split, consecutive), 'defensivePlayingTime')
      ).deep.equals([{ level: 'red', players: [RUTH] }])
      expect(
        of(
          warnings(split, {
            ...consecutive,
            ...largeRoster(
              15,
              { required: 6, consecutive: false },
              DEFAULT_PLAYING_TIME_RULES.largeRoster.innings
            )
          }),
          'defensivePlayingTime'
        )
      ).deep.equals([])
      // Off, 15 players still need the full outs.
      expect(
        of(warnings(oneInningEach(15, 3), inOuts(9)), 'defensivePlayingTime')
      ).deep.equals([{ level: 'red', players: NAMES }])
    })
  })

  describe('Defensive Playing Time in innings', function () {
    it('counts fielded innings up to its deadline', function () {
      // The second inning is not planned yet.
      const list = warnings(
        [
          ['', '', '', 'LF', 'LF'],
          ['', '', 'CF', '', ''],
          ['LF', '', 'LF', '', '']
        ],
        inInnings(2, 3)
      )
      expect(
        list.map(({ level, message }) => ({ level, message }))
      ).deep.equals([
        {
          level: 'red',
          message: `Cannot field 2 innings by inning 3: ${RUTH}`
        },
        { level: 'yellow', message: `Not yet 2 innings by inning 3: ${GEHRIG}` }
      ])
    })

    it('reads no deadline as this game', function () {
      expect(warnings([['LF', '', '']], inInnings(2))[0].message).equals(
        `Not yet 2 innings this game: ${RUTH}`
      )
      // Innings is the default unit: the outs are not judged.
      expect(
        warnings([['LF', 'LF', '']], {
          ...inInnings(2),
          outs: { required: 9, consecutive: true }
        })
      ).deep.equals([])
    })

    it('takes the large roster’s minimum and deadline from its count of players present', function () {
      const reduced = {
        ...inInnings(3),
        ...largeRoster(15, DEFAULT_PLAYING_TIME_RULES.largeRoster.outs, {
          minimum: 1,
          completeBy: 3,
          countPartial: 'fullOnly'
        })
      }
      expect(
        only(
          warnings(oneInningEach(14, 3), reduced),
          'defensivePlayingTime'
        ).map(warning => warning.message.split(':')[0])
      ).deep.equals(['Cannot field 3 innings this game'])
      expect(
        of(warnings(oneInningEach(15, 3), reduced), 'defensivePlayingTime')
      ).deep.equals([])
      expect(
        only(
          warnings(oneInningEach(15, 4), reduced),
          'defensivePlayingTime'
        ).map(warning => warning.message.split(':')[0])
      ).deep.equals(['Cannot field 1 inning by inning 3'])
    })
  })

  describe('a final game', function () {
    // Planned for 6, final after 4. Ruth fields innings 1, 2, 5 and 6, so
    // only two of the innings played; Gehrig and Ruth share LF in inning 5,
    // which was never played.
    const rows: PlanCell[][] = [
      ['LF', 'LF', '', '', 'LF', 'LF'],
      ['CF', 'CF', 'CF', 'CF', 'LF', '']
    ]
    const final = { final: true, playedInnings: 4 }

    it('is judged on the innings it reached', function () {
      const list = warnings(rows, inOuts(9), final)
      expect(of(list, 'duplicatePosition')).deep.equals([])
      expect(of(list, 'defensivePlayingTime')).deep.equals([
        { level: 'red', players: [RUTH] }
      ])
      // Inning 5's deadline is clamped to the 4 played.
      expect(
        only(warnings(rows, inInnings(3, 5), final), 'defensivePlayingTime')[0]
          .message
      ).equals(`Cannot field 3 innings this game: ${RUTH}`)
    })

    it('is never a game still in progress, or one that reached its planned innings', function () {
      const list = warnings(rows, inOuts(9), { playedInnings: 4 })
      expect(of(list, 'defensivePlayingTime')).deep.equals([])
      expect(of(list, 'duplicatePosition')).deep.equals([
        { level: 'red', players: [RUTH, GEHRIG] }
      ])
      expect(
        warnings(rows, inOuts(9), { final: false, playedInnings: 4 })
      ).deep.equals(list)
      expect(
        of(
          warnings(rows, inOuts(9), { final: true, playedInnings: 6 }),
          'duplicatePosition'
        )
      ).deep.equals([{ level: 'red', players: [RUTH, GEHRIG] }])
    })
  })

  describe('infield and outfield minimums', function () {
    it('warns of too few infield innings, red and yellow', function () {
      // The third inning is not planned yet.
      const list = warnings(
        [
          ['LF', 'LF', ''],
          ['CF', 'SS', ''],
          ['SS', '2B', '']
        ],
        { requireMinimumInfield: true, infieldInningsRequired: 2 }
      )
      expect(
        list.map(({ level, message }) => ({ level, message }))
      ).deep.equals([
        {
          level: 'red',
          message: `Cannot play 2 infield innings this game: ${RUTH}`
        },
        {
          level: 'yellow',
          message: `Not yet 2 infield innings this game: ${GEHRIG}`
        }
      ])
    })

    it('counts 1B, 2B, SS and 3B always, and P while Pitcher Counts as Infield is on', function () {
      const rows: PlanCell[][] = [
        ['LF', 'P'],
        ['LF', '1B'],
        ['LF', '3B']
      ]
      expect(
        of(
          warnings(rows, { requireMinimumInfield: true }),
          'requireMinimumInfield'
        )
      ).deep.equals([])
      expect(
        of(
          warnings(rows, {
            requireMinimumInfield: true,
            pitcherCountsAsInfield: false
          }),
          'requireMinimumInfield'
        )
      ).deep.equals([{ level: 'red', players: [RUTH] }])
    })

    it('counts the catcher toward the infield or the outfield, as Catcher Counts As says', function () {
      // Ruth catches only after the first inning, so is no starting catcher.
      const rows: PlanCell[][] = [
        ['SS', 'C'],
        ['LF', 'SS']
      ]
      const minimums = {
        requireMinimumInfield: true,
        requireMinimumOutfield: true
      }
      const short = (
        catcherCountsAs: PlayingTimeRules['catcherCountsAs']
      ): string[] =>
        warnings(rows, { ...minimums, catcherCountsAs }).map(
          warning => `${warning.rule} ${warning.players.join(', ')}`
        )
      expect(short('infield')).deep.equals([`requireMinimumOutfield ${RUTH}`])
      expect(short('outfield')).deep.equals([])
    })

    it('warns of too few outfield innings by their deadline, red and yellow', function () {
      // The third inning is not planned yet.
      const list = warnings(
        [
          ['1B', '1B', '', 'LF'],
          ['2B', 'RF', '', '2B'],
          ['LF', 'CF', '', 'SS']
        ],
        {
          requireMinimumOutfield: true,
          outfieldInningsRequired: 2,
          outfieldBy: 3
        }
      )
      expect(
        list.map(({ level, message }) => ({ level, message }))
      ).deep.equals([
        {
          level: 'red',
          message: `Cannot play 2 outfield innings by inning 3: ${RUTH}`
        },
        {
          level: 'yellow',
          message: `Not yet 2 outfield innings by inning 3: ${GEHRIG}`
        }
      ])
    })
  })

  describe('the starting battery', function () {
    // Ruth pitches and Gehrig catches the first inning; neither plays the
    // outfield, and Gehrig sits twice in a row.
    const rows: PlanCell[][] = [
      ['P', 'P', 'P'],
      ['C', '', ''],
      ['SS', 'LF', 'LF']
    ]

    it('is exempt from the minimums while Starting P/C Exempt from Mins is on', function () {
      const minimum = { requireMinimumOutfield: true }
      expect(of(warnings(rows, minimum), 'requireMinimumOutfield')).deep.equals(
        []
      )
      expect(
        of(
          warnings(rows, {
            ...minimum,
            startingBatteryExemptFromMinimums: false
          }),
          'requireMinimumOutfield'
        )
      ).deep.equals([{ level: 'red', players: [RUTH, GEHRIG] }])
    })

    it('is exempt from the sitting limits while that toggle is on', function () {
      const sitting = { enforceSittingLimits: true, maxSitsPerGame: 3 }
      expect(of(warnings(rows, sitting), 'noConsecutiveSits')).deep.equals([])
      expect(
        of(
          warnings(rows, {
            ...sitting,
            startingBatteryExemptFromSitting: false
          }),
          'noConsecutiveSits'
        )
      ).deep.equals([{ level: 'red', players: [GEHRIG] }])
    })
  })

  describe('sitting limits', function () {
    it('warns red of two sits in a row, and never yellow', function () {
      const sitting = { enforceSittingLimits: true, maxSitsPerGame: 3 }
      // The fourth inning is not planned yet, so holds no sit.
      const list = warnings(
        [
          ['', '', 'LF', ''],
          ['', 'SS', '', ''],
          ['CF', '', 'CF', '']
        ],
        sitting
      )
      expect(list).deep.equals([
        {
          rule: 'noConsecutiveSits',
          level: 'red',
          message: `Sits two innings in a row: ${RUTH}`,
          players: [RUTH]
        }
      ])
      expect(
        warnings(
          [
            ['', ''],
            ['LF', 'LF']
          ],
          { ...sitting, noConsecutiveSits: false, equalSittingOrder: 'off' }
        )
      ).deep.equals([])
    })

    it('warns red above the most sits a game, and never yellow', function () {
      const list = warnings(
        [
          ['', 'LF', '', ''],
          ['', 'SS', 'SS', ''],
          ['CF', 'CF', 'CF', '']
        ],
        { enforceSittingLimits: true, equalSittingOrder: 'off' }
      )
      expect(list).deep.equals([
        {
          rule: 'maxSitsPerGame',
          level: 'red',
          message: `More than 1 sit: ${RUTH}`,
          players: [RUTH]
        }
      ])
      expect(
        warnings(
          [
            ['', 'LF'],
            ['SS', 'SS']
          ],
          {
            enforceSittingLimits: true,
            maxSitsPerGame: 0
          }
        )[0].message
      ).equals(`More than 0 sits: ${RUTH}`)
    })

    it('holds a second sit until everyone else has sat', function () {
      const order = { enforceSittingLimits: true, maxSitsPerGame: 3 }
      // Mantle catches the first inning and never sits, but he is exempt.
      const rows = (dimaggio: PlanCell[]): PlanCell[][] => [
        ['', 'LF', '', 'LF'],
        ['CF', '', 'CF', 'CF'],
        dimaggio,
        ['C', 'C', 'C', 'C']
      ]
      expect(warnings(rows(['RF', 'RF', 'RF', '']), order)).deep.equals([
        {
          rule: 'equalSittingOrder',
          level: 'red',
          message: `Sits a second time before everyone has sat: ${RUTH}`,
          players: [RUTH]
        }
      ])
      // An inning not planned yet could still hold DiMaggio's sit. Mantle,
      // no longer the starting catcher, could sit in it too.
      expect(
        warnings(afterUnplanned(rows(['RF', 'RF', 'RF', ''])), order)
      ).deep.equals([
        {
          rule: 'equalSittingOrder',
          level: 'yellow',
          message: `Sits a second time before everyone has a planned sit: ${RUTH}`,
          players: [RUTH]
        }
      ])
      expect(warnings(rows(['RF', '', 'RF', 'RF']), order)).deep.equals([])
      expect(
        warnings(rows(['RF', 'RF', 'RF', '']), {
          ...order,
          equalSittingOrder: 'off'
        })
      ).deep.equals([])
    })

    it('holds a third sit until everyone else has sat twice', function () {
      const order = {
        enforceSittingLimits: true,
        noConsecutiveSits: false,
        maxSitsPerGame: 3,
        equalSittingOrder: 'thirdAfterAll' as const
      }
      const rows = (dimaggio: PlanCell[]): PlanCell[][] => [
        ['', 'LF', '', 'LF', ''],
        ['CF', '', 'CF', '', 'CF'],
        dimaggio
      ]
      expect(
        of(
          warnings(rows(['', 'RF', 'RF', 'RF', 'RF']), order),
          'equalSittingOrder'
        )
      ).deep.equals([{ level: 'red', players: [RUTH] }])
      const yellow = warnings(
        afterUnplanned(rows(['', 'RF', 'RF', 'RF', 'RF'])),
        order
      )
      expect(yellow.map(warning => warning.message)).deep.equals([
        `Sits a third time before everyone has two planned sits: ${RUTH}`
      ])
      // Second After All lets the same plan stand.
      expect(
        warnings(rows(['', 'RF', 'RF', 'RF', 'RF']), {
          ...order,
          equalSittingOrder: 'secondAfterAll'
        })
      ).deep.equals([])
      expect(
        warnings(rows(['', 'RF', 'RF', 'RF', 'RF']), order)[0].message
      ).equals(`Sits a third time before everyone has sat twice: ${RUTH}`)
    })
  })

  describe('position limits', function () {
    it('warns red of too many innings at one position, and never yellow', function () {
      const limit = { limitInningsAtPosition: true }
      const list = warnings(
        [
          ['SS', 'SS', 'SS', 'SS'],
          ['1B', '', '', ''],
          ['LF', 'LF', 'LF', 'CF']
        ],
        limit
      )
      expect(of(list, 'maxInningsPerPosition')).deep.equals([
        { level: 'red', players: [RUTH] }
      ])
      expect(list[0].message).equals(
        `More than 3 innings at one position: ${RUTH}`
      )
      expect(
        warnings([['SS', 'SS', 'SS', 'SS']], {
          ...limit,
          maxInningsPerPosition: 'unlimited'
        })
      ).deep.equals([])
    })

    it('warns red of one position held past Rotate Every, and never yellow', function () {
      const rotate = { limitInningsAtPosition: true, rotateEvery: 1 as const }
      const list = warnings(
        [
          ['SS', 'SS', 'LF'],
          ['CF', '2B', 'CF'],
          ['RF', '', '']
        ],
        rotate
      )
      expect(list).deep.equals([
        {
          rule: 'rotateEvery',
          level: 'red',
          message: `Same position more than 1 inning in a row: ${RUTH}`,
          players: [RUTH]
        }
      ])
      expect(
        warnings([['SS', 'SS', 'LF']], { ...rotate, rotateEvery: 2 })
      ).deep.equals([])
    })
  })

  describe('catcher limits', function () {
    it('warns red of more innings at catcher than the limit, never yellow, and of none without one', function () {
      const rows: PlanCell[][] = [
        ['C', 'C', 'C', 'C', 'C', 'C'],
        ['C', 'C', 'C', 'C', 'C', 'LF'],
        ['C', 'C', 'C', 'C', 'LF', 'LF'],
        ['C', 'C', 'C', 'LF', 'LF', '']
      ]
      const over = (limit: PlayingTimeRules['catcherMaxInnings']): string[] =>
        only(
          warnings(rows, { catcherMaxInnings: limit }),
          'catcherMaxInnings'
        ).map(warning => warning.message)
      expect(over(3)).deep.equals([
        `Catches more than 3 innings: ${RUTH}, ${GEHRIG}, ${DIMAGGIO}`
      ])
      expect(over(4)).deep.equals([
        `Catches more than 4 innings: ${RUTH}, ${GEHRIG}`
      ])
      expect(over(5)).deep.equals([`Catches more than 5 innings: ${RUTH}`])
      expect(over('none')).deep.equals([])
      expect(
        only(warnings(rows, { catcherMaxInnings: 3 }), 'catcherMaxInnings')[0]
      ).deep.include({ level: 'red', players: [RUTH, GEHRIG, DIMAGGIO] })
      // None is the default.
      expect(only(warnings(rows, {}), 'catcherMaxInnings')).deep.equals([])
    })

    /**
     * The day's other games: what each player caught in those before this
     * one, and who pitches in those after it.
     */
    const day = (
      catcherInnings: Record<string, number>,
      laterPitched: Record<string, boolean> = {}
    ): PlanWarningsInput['sameDay'] => ({
      before: { catcherInnings },
      laterPitched
    })

    it('blocks pitching after N innings at catcher, and not before them', function () {
      const rows: PlanCell[][] = [
        ['C', 'C', 'C', 'P', 'LF'],
        ['C', 'C', 'C', 'C', 'P'],
        ['C', 'C', 'C', 'C', 'C'],
        ['C', 'C', 'P', 'LF', 'LF'],
        ['P', 'C', 'C', 'C', 'C']
      ]
      const blocked = (
        catcherBlocksPitching: PlayingTimeRules['catcherBlocksPitching']
      ): string[] =>
        only(
          warnings(rows, { catcherBlocksPitching }),
          'catcherBlocksPitching'
        ).map(warning => warning.message)
      expect(blocked(3)).deep.equals([
        `Pitches after 3 innings at catcher today: ${RUTH}, ${GEHRIG}`
      ])
      expect(blocked(4)).deep.equals([
        `Pitches after 4 innings at catcher today: ${GEHRIG}`
      ])
      expect(blocked(5)).deep.equals([])
      // Disable, the default, never blocks.
      expect(blocked('none')).deep.equals([])
      expect(only(warnings(rows, {}), 'catcherBlocksPitching')).deep.equals([])
      // Pitching first, then catching four, breaks nothing (Berra, and
      // here a whole game of it).
      expect(
        warnings([['P', 'P', 'C', 'C', 'C', 'C']], { catcherBlocksPitching: 4 })
      ).deep.equals([])
      // A pitch after a fourth inning caught later in the game is blocked,
      // though he pitched before it too.
      expect(
        of(
          warnings([['C', 'C', 'P', 'C', 'C', 'P']], {
            catcherBlocksPitching: 4
          }),
          'catcherBlocksPitching'
        )
      ).deep.equals([{ level: 'red', players: [RUTH] }])
    })

    it('blocks pitching here after catching in the day’s earlier games, not its later ones', function () {
      const blocks = { catcherBlocksPitching: 4 as const }
      const rows: PlanCell[][] = [
        ['P', 'LF', 'LF', 'LF'],
        ['C', 'C', 'P', 'LF'],
        ['C', 'C', 'C', 'C'],
        ['LF', 'LF', 'LF', 'LF']
      ]
      // Ruth caught four innings in an earlier game; Gehrig two, which with
      // two here come before his pitch.
      expect(
        of(
          warnings(rows, blocks, { sameDay: day({ 'g:1': 4, 'g:2': 2 }) }),
          'catcherBlocksPitching'
        )
      ).deep.equals([{ level: 'red', players: [RUTH, GEHRIG] }])
      // Three innings before do not block Ruth. DiMaggio catches four here
      // and pitches in no later game: whatever he pitched earlier that day
      // came first.
      expect(
        of(
          warnings(rows, blocks, { sameDay: day({ 'g:1': 3 }) }),
          'catcherBlocksPitching'
        )
      ).deep.equals([])
      // At 3, those three do.
      expect(
        of(
          warnings(
            rows,
            { catcherBlocksPitching: 3 },
            { sameDay: day({ 'g:1': 3 }) }
          ),
          'catcherBlocksPitching'
        )
      ).deep.equals([{ level: 'red', players: [RUTH] }])
    })

    it('warns red of a pitch in a later game that this game’s catching blocks', function () {
      const rows: PlanCell[][] = [
        ['C', 'C', 'C', 'C'],
        ['C', 'C', 'LF', 'LF'],
        ['C', 'LF', 'LF', 'LF'],
        ['LF', 'LF', 'LF', 'LF']
      ]
      // Ruth catches four here and pitches later; DiMaggio's one inning
      // here makes four with three before; Gehrig's two make only two;
      // Mantle caught four before, which blocks the later pitch already,
      // and the later game's own plan says so.
      const sameDay = day(
        { 'g:3': 3, 'g:4': 4 },
        { 'g:1': true, 'g:2': true, 'g:3': true, 'g:4': true }
      )
      expect(
        only(
          warnings(rows, { catcherBlocksPitching: 4 }, { sameDay }),
          'catcherBlocksPitching'
        )
      ).deep.equals([
        {
          rule: 'catcherBlocksPitching',
          level: 'red',
          message: `Pitches in a later game after 4 innings at catcher today: ${RUTH}, ${DIMAGGIO}`,
          players: [RUTH, DIMAGGIO]
        }
      ])
      // At 5, Ruth's four do not block him; DiMaggio's four do not either.
      expect(
        only(
          warnings(rows, { catcherBlocksPitching: 5 }, { sameDay }),
          'catcherBlocksPitching'
        )
      ).deep.equals([])
    })
  })

  describe('innings not planned yet', function () {
    // Ten players, planned for innings 1 and 2 of 6: Gehrig sits the
    // first and Gibson the second.
    const twoPlanned = (): PlanCell[][] =>
      [
        ['P', 'P'],
        ['', 'C'],
        ['1B', '1B'],
        ['2B', '2B'],
        ['SS', 'SS'],
        ['3B', '3B'],
        ['LF', 'LF'],
        ['CF', 'CF'],
        ['RF', 'RF'],
        ['C', '']
      ].map((cells): PlanCell[] => [...(cells as PlanCell[]), '', '', '', ''])
    const sitting = {
      enforceSittingLimits: true,
      maxSitsPerGame: 0,
      startingBatteryExemptFromSitting: false
    }

    it('raise no sits', function () {
      // Every player sits innings 3 to 6 by their blanks, which count for
      // nothing; only the two planned sits do.
      expect(of(warnings(twoPlanned(), sitting), 'maxSitsPerGame')).deep.equals(
        [{ level: 'red', players: [GEHRIG, NAMES[9]] }]
      )
      expect(
        warnings(twoPlanned(), { ...sitting, maxSitsPerGame: 1 })
      ).deep.equals([])
    })

    it('leave a minimum whose deadline reaches them yellow, and red once planned without it', function () {
      const stricter = inInnings(2, 4)
      expect(
        of(warnings(twoPlanned(), stricter), 'defensivePlayingTime')
      ).deep.equals([{ level: 'yellow', players: [GEHRIG, NAMES[9]] }])
      // Innings 3 and 4 planned with both on the bench.
      const planned = twoPlanned().map((cells, at): PlanCell[] => [
        ...cells.slice(0, 2),
        at === 1 || at === 9 ? '' : cells[0],
        at === 1 || at === 9 ? '' : cells[0],
        ...cells.slice(4)
      ])
      expect(
        of(warnings(planned, stricter), 'defensivePlayingTime')
      ).deep.equals([{ level: 'red', players: [GEHRIG, NAMES[9]] }])
    })

    it('include a column of only DH, EH and blanks', function () {
      const rows: PlanCell[][] = [
        ['LF', 'DH'],
        ['CF', ''],
        ['RF', 'EH']
      ]
      expect(
        warnings(rows, { enforceSittingLimits: true, maxSitsPerGame: 0 })
      ).deep.equals([])
      expect(
        of(warnings(rows, inInnings(2)), 'defensivePlayingTime')
      ).deep.equals([{ level: 'yellow', players: [RUTH, GEHRIG, DIMAGGIO] }])
      // Planned, its blank is a sit.
      const fielded: PlanCell[][] = [['LF', 'SS'], ...rows.slice(1)]
      expect(
        of(
          warnings(fielded, { enforceSittingLimits: true, maxSitsPerGame: 0 }),
          'maxSitsPerGame'
        )
      ).deep.equals([{ level: 'red', players: [GEHRIG] }])
    })

    it('keep consecutive outs across them yellow', function () {
      const consecutive = inOuts(9, true)
      // Ruth sits the first inning and fields the second; three and four
      // are not planned yet.
      const rows: PlanCell[][] = [
        ['', 'LF', '', ''],
        ['SS', 'SS', '', '']
      ]
      expect(
        of(warnings(rows, consecutive), 'defensivePlayingTime')
      ).deep.equals([{ level: 'yellow', players: [RUTH, GEHRIG] }])
      // The third planned with Ruth on the bench breaks his run.
      expect(
        of(
          warnings(
            [
              ['', 'LF', '', ''],
              ['SS', 'SS', 'SS', '']
            ],
            consecutive
          ),
          'defensivePlayingTime'
        )
      ).deep.equals([{ level: 'red', players: [RUTH] }])
    })
  })

  it('warns of nothing for the batting-order rules', function () {
    expect(
      warnings(
        [
          ['', '', ''],
          ['LF', 'LF', 'LF'],
          ['DH', 'EH', '']
        ],
        {
          continuousBatting: true,
          lateArrivalsToEnd: true,
          departuresSkipWithoutOut: true
        }
      )
    ).deep.equals([])
  })

  it('has no season tracking: a set that tracked the season warns of nothing for it', function () {
    const tracked = asPlayingTimeRules({
      trackSeasonInfieldBalance: true,
      rotateLeadoff: true,
      mustPlayNextSuggestions: true
    })
    expect(tracked).deep.equals(DEFAULT_PLAYING_TIME_RULES)
    expect(
      planWarnings({
        plan: {
          enabled: true,
          innings: 2,
          rows: [
            { player: PLAYERS[0], cells: ['', 'LF'] },
            { player: PLAYERS[1], cells: ['SS', ''] }
          ]
        },
        rules: tracked,
        sameDay: EMPTY_PLAN_SAME_DAY
      })
    ).deep.equals([])
  })

  it('lists reds before yellows', function () {
    // The third inning is not planned yet.
    const list = warnings(
      [
        ['1B', '', ''],
        ['', '', ''],
        ['SS', '2B', '']
      ],
      {
        ...inOuts(6),
        infieldInningsRequired: 2,
        requireMinimumInfield: true
      }
    )
    expect(list.map(({ rule, level }) => `${rule} ${level}`)).deep.equals([
      'defensivePlayingTime red',
      'requireMinimumInfield red',
      'defensivePlayingTime yellow',
      'requireMinimumInfield yellow'
    ])
  })

  it('summarises the warnings for the notices', function () {
    const red: PlanWarning = {
      rule: 'duplicatePosition',
      level: 'red',
      message: '',
      players: []
    }
    const yellow: PlanWarning = { ...red, level: 'yellow' }
    expect(warningSummary([])).deep.equals({ red: 0, yellow: 0, text: '' })
    expect(warningSummary([red])).deep.equals({
      red: 1,
      yellow: 0,
      text: '1 playing-time warning'
    })
    expect(warningSummary([yellow, yellow, yellow])).deep.equals({
      red: 0,
      yellow: 3,
      text: '3 playing-time warnings'
    })
    expect(warningSummary([red, yellow, red])).deep.equals({
      red: 2,
      yellow: 1,
      text: '2 red and 1 yellow playing-time warnings'
    })
  })
})
