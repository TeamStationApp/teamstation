import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { LineupPlayer } from './api'
import { type PlanCell, type PlanRowCounts, planRowCounts } from './gamePlan'
import {
  EMPTY_PLAN_HISTORY,
  EMPTY_PLAN_SAME_DAY,
  type PlanWarning,
  planWarnings,
  type PlanWarningsInput,
  warningSummary
} from './planWarnings'
import {
  DEFAULT_PLAYING_TIME_RULES,
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
const [RUTH, GEHRIG, DIMAGGIO, MANTLE, BERRA] = NAMES

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
    history: EMPTY_PLAN_HISTORY,
    sameDay: EMPTY_PLAN_SAME_DAY,
    ...extra
  })
}

/** A season's innings at the positions given, and none elsewhere. */
const season = (
  positions: Partial<PlanRowCounts['positions']>,
  sits = 0
): PlanRowCounts => ({
  positions: { ...planRowCounts([]).positions, ...positions },
  sits
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

/** `count` rows that each field one inning of `innings` and sit the rest. */
const oneInningEach = (count: number, innings: number): PlanCell[][] =>
  Array.from({ length: count }, () => [
    'LF',
    ...Array<PlanCell>(innings - 1).fill('-')
  ])

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
    expect(warnings([[''], [''], ['-'], ['-']], rules())).deep.equals([])
  })

  it('warns of nothing else while every rule is off', function () {
    expect(
      warnings(
        [
          ['-', '-', '-'],
          ['C', 'C', 'C'],
          ['', '', '']
        ],
        {}
      )
    ).deep.equals([])
  })

  describe('Mandatory Play', function () {
    it('is red when the outs are out of reach and yellow while blanks could meet them', function () {
      const list = warnings(
        [
          ['P', 'P', 'P'],
          ['-', '-', 'LF'],
          ['-', '', 'RF'],
          ['-', '-', '-']
        ],
        { mandatoryPlay: true }
      )
      expect(of(list, 'mandatoryPlay')).deep.equals([
        { level: 'red', players: [GEHRIG, MANTLE] },
        { level: 'yellow', players: [DIMAGGIO] }
      ])
      expect(list.map(warning => warning.message)).deep.equals([
        `Cannot reach 6 defensive outs: ${GEHRIG}, ${MANTLE}`,
        `Not yet 6 defensive outs: ${DIMAGGIO}`
      ])
    })

    it('needs consecutive innings when Must Be Consecutive is on', function () {
      const list = warnings(
        [
          ['LF', '-', 'LF', '-'],
          ['CF', '', '-', '-'],
          ['RF', 'RF', '-', '-']
        ],
        { mandatoryPlay: true, mustBeConsecutive: true }
      )
      expect(of(list, 'mandatoryPlay')).deep.equals([
        { level: 'red', players: [RUTH] },
        { level: 'yellow', players: [GEHRIG] }
      ])
      expect(list[0].message).equals(
        `Cannot reach 6 consecutive defensive outs: ${RUTH}`
      )
    })

    it('relaxes the outs from 15 players present, not at 14', function () {
      const reduced = { mandatoryPlay: true, reducedForLargeRosters: true }
      expect(
        of(warnings(oneInningEach(14, 3), reduced), 'mandatoryPlay')
      ).deep.equals([{ level: 'red', players: NAMES.slice(0, 14) }])
      expect(
        of(warnings(oneInningEach(15, 3), reduced), 'mandatoryPlay')
      ).deep.equals([])
      // Off, 15 players still need the full outs.
      expect(
        of(
          warnings(oneInningEach(15, 3), { mandatoryPlay: true }),
          'mandatoryPlay'
        )
      ).deep.equals([{ level: 'red', players: NAMES }])
    })
  })

  describe('a shortened game', function () {
    // Planned for 6, final after 4. Ruth fields innings 1, 2, 5 and 6, so
    // only two of the innings played; Gehrig and Ruth share LF in inning 5,
    // which was never played.
    const rows: PlanCell[][] = [
      ['LF', 'LF', '-', '-', 'LF', 'LF'],
      ['CF', 'CF', 'CF', 'CF', 'LF', '-']
    ]
    const nine = (
      applyInShortenedGames: PlayingTimeRules['applyInShortenedGames']
    ): Partial<PlayingTimeRules> => ({
      mandatoryPlay: true,
      defensiveOutsRequired: 9,
      applyInShortenedGames,
      stricterMinimumInnings: true,
      minimumFullInnings: 3,
      minimumInningsBy: 5
    })
    const final = { final: true, playedInnings: 4 }

    it('judges only the innings played, and applies Always in full', function () {
      const list = warnings(rows, nine('always'), final)
      expect(of(list, 'duplicatePosition')).deep.equals([])
      expect(of(list, 'mandatoryPlay')).deep.equals([
        { level: 'red', players: [RUTH] }
      ])
      // Inning 5's deadline is clamped to the 4 played.
      expect(
        list.find(warning => warning.rule === 'stricterMinimumInnings')?.message
      ).equals(`Cannot field 3 innings this game: ${RUTH}`)
    })

    it('turns Mandatory Play red into yellow under Local Option', function () {
      const list = warnings(rows, nine('localOption'), final)
      expect(of(list, 'mandatoryPlay')).deep.equals([
        { level: 'yellow', players: [RUTH] }
      ])
      // Only Mandatory Play follows the shortened-game choice.
      expect(of(list, 'stricterMinimumInnings')).deep.equals([
        { level: 'red', players: [RUTH] }
      ])
    })

    it('skips Mandatory Play under Never', function () {
      const list = warnings(rows, nine('never'), final)
      expect(of(list, 'mandatoryPlay')).deep.equals([])
      expect(of(list, 'stricterMinimumInnings')).deep.equals([
        { level: 'red', players: [RUTH] }
      ])
    })

    it('is never a game still in progress', function () {
      const list = warnings(rows, nine('never'), { playedInnings: 4 })
      expect(of(list, 'mandatoryPlay')).deep.equals([])
      expect(of(list, 'duplicatePosition')).deep.equals([
        { level: 'red', players: [RUTH, GEHRIG] }
      ])
      expect(
        warnings(rows, nine('never'), { final: false, playedInnings: 4 })
      ).deep.equals(list)
      // A final game that reached its planned innings is not shortened.
      expect(
        of(
          warnings(rows, nine('never'), { final: true, playedInnings: 6 }),
          'duplicatePosition'
        )
      ).deep.equals([{ level: 'red', players: [RUTH, GEHRIG] }])
    })
  })

  describe('Stricter Minimum Innings', function () {
    it('counts fielded innings up to its deadline', function () {
      const list = warnings(
        [
          ['-', '-', 'LF', 'LF', 'LF'],
          ['-', '', 'CF', '', ''],
          ['LF', 'LF', '-', '-', '-']
        ],
        { stricterMinimumInnings: true, minimumInningsBy: 3 }
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

    it('reads a game-end deadline as this game', function () {
      expect(
        warnings([['LF', '-', '']], {
          stricterMinimumInnings: true,
          minimumFullInnings: 2
        })[0].message
      ).equals(`Not yet 2 innings this game: ${RUTH}`)
    })
  })

  describe('infield and outfield minimums', function () {
    it('warns of too few infield innings, red and yellow', function () {
      const list = warnings(
        [
          ['LF', 'LF'],
          ['CF', ''],
          ['SS', 'RF']
        ],
        { requireMinimumInfield: true }
      )
      expect(
        list.map(({ level, message }) => ({ level, message }))
      ).deep.equals([
        {
          level: 'red',
          message: `Cannot play 1 infield inning this game: ${RUTH}`
        },
        {
          level: 'yellow',
          message: `Not yet 1 infield inning this game: ${GEHRIG}`
        }
      ])
    })

    it('counts only the selected infield positions', function () {
      const list = warnings(
        [
          ['LF', '1B'],
          ['LF', 'SS']
        ],
        { requireMinimumInfield: true, infieldPositions: ['SS'] }
      )
      expect(of(list, 'requireMinimumInfield')).deep.equals([
        { level: 'red', players: [RUTH] }
      ])
    })

    it('counts the catcher as infield as Catcher Counts as Infield says', function () {
      // Ruth catches only after the first inning, so is no starting catcher.
      const roster = (count: number): PlanCell[][] => [
        ['LF', 'C'],
        ...Array.from({ length: count - 1 }, (): PlanCell[] => ['SS', 'LF'])
      ]
      const counts = (
        catcherCountsAsInfield: PlayingTimeRules['catcherCountsAsInfield'],
        size: number
      ): string[] =>
        warnings(roster(size), {
          requireMinimumInfield: true,
          catcherCountsAsInfield
        })
          .filter(warning => warning.rule === 'requireMinimumInfield')
          .flatMap(warning => warning.players)
      expect(counts('largeRoster', 12)).deep.equals([RUTH])
      expect(counts('largeRoster', 13)).deep.equals([])
      expect(counts('always', 12)).deep.equals([])
      expect(counts('off', 13)).deep.equals([RUTH])
    })

    it('warns of too few outfield innings by their deadline, red and yellow', function () {
      const list = warnings(
        [
          ['1B', '1B', '1B', 'LF'],
          ['2B', '', '2B', '2B'],
          ['SS', 'RF', 'SS', 'SS']
        ],
        { requireMinimumOutfield: true, outfieldBy: 3 }
      )
      expect(
        list.map(({ level, message }) => ({ level, message }))
      ).deep.equals([
        {
          level: 'red',
          message: `Cannot play 1 outfield inning by inning 3: ${RUTH}`
        },
        {
          level: 'yellow',
          message: `Not yet 1 outfield inning by inning 3: ${GEHRIG}`
        }
      ])
    })
  })

  describe('the starting battery', function () {
    // Ruth pitches and Gehrig catches the first inning; neither plays the
    // outfield, and Gehrig sits twice in a row.
    const rows: PlanCell[][] = [
      ['P', 'P', 'P'],
      ['C', '-', '-'],
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
      const list = warnings(
        [
          ['-', '-', 'LF'],
          ['-', '', '-'],
          ['CF', '-', 'CF']
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
        warnings([['-', '-']], { ...sitting, noConsecutiveSits: false })
      ).deep.equals([])
    })

    it('warns red above the most sits a game, and never yellow', function () {
      const list = warnings(
        [
          ['-', 'LF', '-'],
          ['-', '', ''],
          ['CF', 'CF', 'CF']
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
        warnings([['-', 'LF']], {
          enforceSittingLimits: true,
          maxSitsPerGame: 0
        })[0].message
      ).equals(`More than 0 sits: ${RUTH}`)
    })

    it('holds a second sit until everyone else has sat', function () {
      const order = { enforceSittingLimits: true, maxSitsPerGame: 3 }
      // Mantle catches the first inning and never sits, but he is exempt.
      const rows = (dimaggio: PlanCell[]): PlanCell[][] => [
        ['-', 'LF', '-', 'LF'],
        ['CF', '-', 'CF', 'CF'],
        dimaggio,
        ['C', 'C', 'C', 'C']
      ]
      expect(warnings(rows(['RF', 'RF', 'RF', '-']), order)).deep.equals([
        {
          rule: 'equalSittingOrder',
          level: 'red',
          message: `Sits a second time before everyone has sat: ${RUTH}`,
          players: [RUTH]
        }
      ])
      expect(warnings(rows(['RF', 'RF', '', '-']), order)).deep.equals([
        {
          rule: 'equalSittingOrder',
          level: 'yellow',
          message: `Sits a second time before everyone has a planned sit: ${RUTH}`,
          players: [RUTH]
        }
      ])
      expect(warnings(rows(['RF', '-', 'RF', 'RF']), order)).deep.equals([])
      expect(
        warnings(rows(['RF', 'RF', 'RF', '-']), {
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
        ['-', 'LF', '-', 'LF', '-'],
        ['CF', '-', 'CF', '-', 'CF'],
        dimaggio
      ]
      expect(
        of(
          warnings(rows(['-', 'RF', 'RF', 'RF', 'RF']), order),
          'equalSittingOrder'
        )
      ).deep.equals([{ level: 'red', players: [RUTH] }])
      const yellow = warnings(rows(['-', 'RF', '', 'RF', 'RF']), order)
      expect(yellow.map(warning => warning.message)).deep.equals([
        `Sits a third time before everyone has two planned sits: ${RUTH}`
      ])
      // Second After All lets the same plan stand.
      expect(
        warnings(rows(['-', 'RF', 'RF', 'RF', 'RF']), {
          ...order,
          equalSittingOrder: 'secondAfterAll'
        })
      ).deep.equals([])
      expect(
        warnings(rows(['-', 'RF', 'RF', 'RF', 'RF']), order)[0].message
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

    it('needs an infield and an outfield inning when Must Play Both is on', function () {
      const both = {
        requireMinimumOutfield: true,
        mustPlayInfieldAndOutfield: true
      }
      const list = warnings(
        [
          ['SS', 'SS'],
          ['SS', ''],
          ['SS', 'LF'],
          ['', ''],
          ['-', '']
        ],
        both
      )
      expect(of(list, 'mustPlayInfieldAndOutfield')).deep.equals([
        { level: 'red', players: [RUTH, BERRA] },
        { level: 'yellow', players: [GEHRIG, MANTLE] }
      ])
      expect(
        list
          .filter(warning => warning.rule === 'mustPlayInfieldAndOutfield')
          .map(warning => warning.message)
      ).deep.equals([
        `Cannot play both infield and outfield: ${RUTH}, ${BERRA}`,
        `Not yet played both infield and outfield: ${GEHRIG}, ${MANTLE}`
      ])
      // Off while both minimums are off.
      expect(
        warnings([['SS', 'SS']], { mustPlayInfieldAndOutfield: true })
      ).deep.equals([])
    })
  })

  describe('catcher limits', function () {
    it('warns red of too many innings at catcher, and never yellow', function () {
      const list = warnings(
        [
          ['C', 'C', 'C', 'C'],
          ['LF', 'LF', 'LF', ''],
          ['CF', '', '', '']
        ],
        { catcherInningLimit: true, catcherMaxInnings: 3 }
      )
      expect(list).deep.equals([
        {
          rule: 'catcherInningLimit',
          level: 'red',
          message: `Catches more than 3 innings: ${RUTH}`,
          players: [RUTH]
        }
      ])
      expect(
        warnings([['C', 'C', 'C', 'LF']], {
          catcherInningLimit: true,
          catcherMaxInnings: 3
        })
      ).deep.equals([])
    })

    /**
     * The day's other games: what each player caught in those before this
     * one, and who pitches in those after it.
     */
    const day = (
      catcherInnings: Record<string, number>,
      caughtFourth: Record<string, boolean> = {},
      laterPitched: Record<string, boolean> = {}
    ): PlanWarningsInput['sameDay'] => ({
      before: { catcherInnings, caughtFourth },
      laterPitched
    })

    it('blocks pitching after four innings at catcher, and not before them', function () {
      const blocks = { catcherBlocksPitching: true }
      const rows: PlanCell[][] = [
        ['C', 'C', 'C', 'C', 'P'],
        ['C', 'C', 'P', 'LF', 'LF'],
        ['C', 'C', 'C', 'C', 'LF'],
        ['LF', 'LF', 'LF', 'C', 'P'],
        ['P', 'C', 'C', 'C', 'C']
      ]
      expect(of(warnings(rows, blocks), 'catcherBlocksPitching')).deep.equals([
        { level: 'red', players: [RUTH] }
      ])
      expect(
        only(warnings(rows, blocks), 'catcherBlocksPitching')[0].message
      ).equals(`Pitches after 4 innings at catcher today: ${RUTH}`)
      // Pitching first, then catching four, breaks nothing (Berra, and
      // here a whole game of it).
      expect(warnings([['P', 'P', 'C', 'C', 'C', 'C']], blocks)).deep.equals([])
      // A pitch after a fourth inning caught later in the game is blocked,
      // though he pitched before it too.
      expect(
        of(
          warnings([['C', 'C', 'P', 'C', 'C', 'P']], blocks),
          'catcherBlocksPitching'
        )
      ).deep.equals([{ level: 'red', players: [RUTH] }])
    })

    it('blocks pitching here after catching in the day’s earlier games, not its later ones', function () {
      const blocks = { catcherBlocksPitching: true }
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
    })

    it('warns red of a pitch in a later game that this game’s catching blocks', function () {
      const blocks = { catcherBlocksPitching: true }
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
      const list = warnings(rows, blocks, {
        sameDay: day(
          { 'g:3': 3, 'g:4': 4 },
          {},
          { 'g:1': true, 'g:2': true, 'g:3': true, 'g:4': true }
        )
      })
      expect(only(list, 'catcherBlocksPitching')).deep.equals([
        {
          rule: 'catcherBlocksPitching',
          level: 'red',
          message: `Pitches in a later game after 4 innings at catcher today: ${RUTH}, ${DIMAGGIO}`,
          players: [RUTH, DIMAGGIO]
        }
      ])
    })

    it('blocks pitching after catching a fourth inning when that toggle is on', function () {
      const fourth = {
        catcherBlocksPitching: true,
        catcherBlocksIfCatchesFourth: true
      }
      const rows: PlanCell[][] = [
        ['LF', 'LF', 'LF', 'C', 'P'],
        ['P', 'LF', 'LF', 'LF', 'LF'],
        ['P', 'C', 'C', 'LF', 'LF'],
        ['P', 'LF', 'LF', 'C', 'LF'],
        ['LF', 'LF', 'LF', 'C', 'LF']
      ]
      // Gehrig caught the fourth inning of the day's earlier game; Berra
      // catches this one's and pitches in a later one.
      const sameDay = day({}, { 'g:2': true }, { 'g:5': true })
      const list = warnings(rows, fourth, { sameDay })
      expect(only(list, 'catcherBlocksPitching')).deep.equals([
        {
          rule: 'catcherBlocksPitching',
          level: 'red',
          message: `Pitches after 4 innings, or the 4th inning, at catcher today: ${RUTH}, ${GEHRIG}`,
          players: [RUTH, GEHRIG]
        },
        {
          rule: 'catcherBlocksPitching',
          level: 'red',
          message: `Pitches in a later game after 4 innings, or the 4th inning, at catcher today: ${BERRA}`,
          players: [BERRA]
        }
      ])
      // Mantle pitched before he caught the fourth inning, which is allowed.
      // Without the toggle, a fourth inning is one inning like the others.
      expect(
        only(
          warnings(rows, { catcherBlocksPitching: true }, { sameDay }),
          'catcherBlocksPitching'
        )
      ).deep.equals([])
    })
  })

  it('warns of nothing for the batting-order rules', function () {
    expect(
      warnings(
        [
          ['-', '-', '-'],
          ['', '', ''],
          ['DH', 'EH', '-']
        ],
        {
          continuousBatting: true,
          lateArrivalsToEnd: true,
          departuresSkipWithoutOut: true
        }
      )
    ).deep.equals([])
  })

  describe('season tracking', function () {
    it('warns yellow of a season infield share under half the team mean', function () {
      const history = {
        ...EMPTY_PLAN_HISTORY,
        players: {
          'g:1': season({ LF: 10 }),
          'g:2': season({ SS: 10 }),
          'g:3': season({ SS: 5, CF: 5 })
        }
      }
      // Mantle has never fielded, so has no share.
      const list = warnings(
        [
          ['LF', 'LF'],
          ['SS', 'SS'],
          ['SS', 'LF'],
          ['-', '-']
        ],
        { trackSeasonInfieldBalance: true },
        { history }
      )
      expect(only(list, 'trackSeasonInfieldBalance')).deep.equals([
        {
          rule: 'trackSeasonInfieldBalance',
          level: 'yellow',
          message: `Few infield innings this season: ${RUTH}`,
          players: [RUTH]
        }
      ])
    })

    it('judges infield balance on the rule’s infield positions, as the infield minimum does', function () {
      const balance = { trackSeasonInfieldBalance: true }
      // Ruth is the regular catcher, Gehrig the shortstop; DiMaggio splits
      // shortstop and left field.
      const history = {
        ...EMPTY_PLAN_HISTORY,
        players: {
          'g:1': season({ C: 10 }),
          'g:2': season({ SS: 10 }),
          'g:3': season({ SS: 5, LF: 5 })
        }
      }
      const rows: PlanCell[][] = [
        ['C', 'C'],
        ['SS', 'SS'],
        ['SS', 'LF']
      ]
      const flagged = (changes: Partial<PlayingTimeRules>): string[] =>
        only(
          warnings(rows, { ...balance, ...changes }, { history }),
          'trackSeasonInfieldBalance'
        ).flatMap(warning => warning.players)
      expect(flagged({ catcherCountsAsInfield: 'always' })).deep.equals([])
      expect(flagged({ catcherCountsAsInfield: 'off' })).deep.equals([RUTH])
      // Large Roster counts the catcher only with more than 12 players.
      expect(flagged({ catcherCountsAsInfield: 'largeRoster' })).deep.equals([
        RUTH
      ])
      // A pitcher, with P left out of the infield.
      const pitcher = {
        ...history,
        players: { ...history.players, 'g:1': season({ P: 10 }) }
      }
      const pitching: PlanCell[][] = [['P', 'P'], ...rows.slice(1)]
      expect(
        of(
          warnings(pitching, balance, { history: pitcher }),
          'trackSeasonInfieldBalance'
        )
      ).deep.equals([])
      expect(
        of(
          warnings(
            pitching,
            {
              ...balance,
              infieldPositions: ['C', '1B', '2B', 'SS', '3B']
            },
            { history: pitcher }
          ),
          'trackSeasonInfieldBalance'
        )
      ).deep.equals([{ level: 'yellow', players: [RUTH] }])
    })

    it('warns yellow when last game’s leadoff leads off again', function () {
      const leadoff = { rotateLeadoff: true }
      const history = { ...EMPTY_PLAN_HISTORY, lastLeadoff: 'g:1' }
      expect(
        of(warnings([['LF'], ['SS']], leadoff, { history }), 'rotateLeadoff')
      ).deep.equals([{ level: 'yellow', players: [RUTH] }])
      expect(
        warnings([['LF'], ['SS']], leadoff, {
          history: { ...history, lastLeadoff: 'g:2' }
        })
      ).deep.equals([])
      expect(warnings([['LF']], leadoff)).deep.equals([])
    })

    it('warns yellow when last game’s most-sat player sits the first inning', function () {
      const next = { mustPlayNextSuggestions: true }
      const history = {
        ...EMPTY_PLAN_HISTORY,
        lastGameSits: { 'g:1': 2, 'g:2': 2, 'g:3': 1 }
      }
      const rows: PlanCell[][] = [
        ['-', 'LF'],
        ['LF', '-'],
        ['-', 'CF']
      ]
      expect(warnings(rows, next, { history })).deep.equals([
        {
          rule: 'mustPlayNextSuggestions',
          level: 'yellow',
          message: `Sat the most last game, and sits in inning 1: ${RUTH}`,
          players: [RUTH]
        }
      ])
      expect(warnings(rows, next)).deep.equals([])
    })

    it('never warns red', function () {
      const list = warnings(
        [
          ['-', '-', '-'],
          ['SS', 'SS', 'SS'],
          ['LF', 'LF', 'LF']
        ],
        {
          trackSeasonInfieldBalance: true,
          rotateLeadoff: true,
          mustPlayNextSuggestions: true
        },
        {
          history: {
            players: { 'g:1': season({ RF: 9 }) },
            lastLeadoff: 'g:1',
            lastGameSits: { 'g:1': 3 }
          }
        }
      )
      expect(list.map(warning => warning.rule)).deep.equals([
        'trackSeasonInfieldBalance',
        'rotateLeadoff',
        'mustPlayNextSuggestions'
      ])
      expect(list.every(warning => warning.level === 'yellow')).equals(true)
    })
  })

  it('lists reds before yellows', function () {
    const list = warnings(
      [
        ['-', ''],
        ['-', '-']
      ],
      {
        mandatoryPlay: true,
        defensiveOutsRequired: 3,
        rotateLeadoff: true,
        requireMinimumInfield: true
      },
      { history: { ...EMPTY_PLAN_HISTORY, lastLeadoff: 'g:1' } }
    )
    expect(list.map(({ rule, level }) => `${rule} ${level}`)).deep.equals([
      'mandatoryPlay red',
      'requireMinimumInfield red',
      'mandatoryPlay yellow',
      'requireMinimumInfield yellow',
      'rotateLeadoff yellow'
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
