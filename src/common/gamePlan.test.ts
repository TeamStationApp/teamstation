import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { LineupPlayer } from './api'
import {
  addInning,
  alignPlan,
  asGamePlan,
  asPlanColumnCell,
  clearPlan,
  columnPlan,
  completeCell,
  DEFAULT_PLAN_INNINGS,
  duplicatedCells,
  type GamePlan,
  inningDefense,
  MAX_PLAN_INNINGS,
  PLAN_CELLS,
  type PlanCell,
  planCellEntry,
  planCellOf,
  planColumn,
  planHasPositions,
  plannedInnings,
  planPlayerKey,
  planPositionErrors,
  positionList,
  removeInning
} from './gamePlan'
import { type Position, POSITIONS } from './scoring/state'

const ruth: LineupPlayer = { gumboId: 3, fullName: 'Ruth B', jersey: '3' }
const gehrig: LineupPlayer = { gumboId: 4, fullName: 'Gehrig L', jersey: '4' }
const dimaggio: LineupPlayer = {
  gumboId: 5,
  fullName: 'DiMaggio J',
  jersey: '5'
}
const mantle: LineupPlayer = {
  gumboId: null,
  fullName: 'Mantle M',
  jersey: '7'
}

const plan = (
  rows: Array<[LineupPlayer, PlanCell[]]>,
  innings = rows[0]?.[1].length ?? DEFAULT_PLAN_INNINGS
): GamePlan => ({
  enabled: true,
  innings,
  rows: rows.map(([player, cells]) => ({ player, cells }))
})

describe('game plan model', function () {
  describe('planCellOf', function () {
    it('accepts every value, in either case, and a blank', function () {
      for (const cell of PLAN_CELLS) {
        expect(planCellOf(cell)).equals(cell)
        expect(planCellOf(cell.toLowerCase())).equals(cell)
      }
      expect(planCellOf('')).equals('')
      expect(planCellOf(' ')).equals('')
      expect(planCellOf(' c')).equals('C')
      expect(planCellOf('1b')).equals('1B')
      // The bench is blank, not a dash.
      expect(PLAN_CELLS).not.includes('-')
    })

    it('refuses anything else, and text longer than a cell', function () {
      for (const text of [
        'X',
        '1',
        'SSS',
        'LF ',
        'Q',
        'S',
        'CC',
        'P1',
        '-',
        '--'
      ])
        expect(planCellOf(text), text).equals(null)
    })
  })

  describe('completeCell', function () {
    it('completes each first key, in either case, to the one value it starts', function () {
      const table: Array<[string, PlanCell]> = [
        ['1', '1B'],
        ['2', '2B'],
        ['3', '3B'],
        ['S', 'SS'],
        ['L', 'LF'],
        ['R', 'RF'],
        ['D', 'DH'],
        ['E', 'EH'],
        ['P', 'P'],
        ['C', 'C']
      ]
      for (const [key, cell] of table) {
        expect(completeCell(key), key).equals(cell)
        expect(completeCell(key.toLowerCase()), key).equals(cell)
      }
      // Every value but CF is one first key away.
      expect(
        PLAN_CELLS.filter(cell => !table.some(([, each]) => each === cell))
      ).deep.equals(['CF'])
    })

    it('completes nothing else', function () {
      for (const key of ['X', 'q', 'F', 'B', 'H', '4', '-', ' ', '', 'Shift'])
        expect(completeCell(key), key).equals(null)
    })
  })

  describe('planCellEntry', function () {
    it('commits a first key’s completion at once, and holds C for an F', function () {
      expect(planCellEntry('', '1')).deep.equals({ commit: '1B' })
      expect(planCellEntry('', 's')).deep.equals({ commit: 'SS' })
      expect(planCellEntry('', 'P')).deep.equals({ commit: 'P' })
      expect(planCellEntry('', 'c')).deep.equals({ pending: 'C' })
      expect(planCellEntry('C', 'f')).deep.equals({ commit: 'CF' })
      expect(planCellEntry('C', 'F')).deep.equals({ commit: 'CF' })
    })

    it('refuses what completes nothing', function () {
      for (const [editing, key] of [
        ['', 'X'],
        ['', 'q'],
        ['', '-'],
        ['C', 'C'],
        ['C', 'x'],
        ['C', ' '],
        ['C', '1']
      ])
        expect(planCellEntry(editing, key), `${editing}${key}`).deep.equals({
          refuse: true
        })
    })
  })

  describe('alignPlan', function () {
    it('follows the batting order, matching by gumboId and by name and jersey', function () {
      const stored = plan([
        [ruth, ['P', 'P', 'P']],
        [mantle, ['CF', 'CF', 'LF']],
        [gehrig, ['1B', '1B', '']]
      ])
      // Gehrig's name reads differently now; Mantle has no gumboId.
      const renamed = { ...gehrig, fullName: 'Gehrig H L' }
      const aligned = alignPlan(stored, [renamed, ruth, mantle, dimaggio])
      expect(aligned.enabled).equals(true)
      expect(aligned.innings).equals(3)
      expect(aligned.rows).deep.equals([
        { player: renamed, cells: ['1B', '1B', ''] },
        { player: ruth, cells: ['P', 'P', 'P'] },
        { player: mantle, cells: ['CF', 'CF', 'LF'] },
        { player: dimaggio, cells: ['', '', ''] }
      ])
    })

    it('drops a row nobody bats in, and gives each row to one batter', function () {
      const twin = { ...mantle }
      const aligned = alignPlan(
        plan([
          [mantle, ['LF', 'LF']],
          [dimaggio, ['CF', 'CF']]
        ]),
        [mantle, twin]
      )
      expect(aligned.rows.map(row => row.cells)).deep.equals([
        ['LF', 'LF'],
        ['', '']
      ])
    })

    it('pads and cuts the cells to the innings', function () {
      const stored: GamePlan = {
        enabled: false,
        innings: 3,
        rows: [
          { player: ruth, cells: ['P'] },
          { player: gehrig, cells: ['1B', '1B', '1B', '1B', '1B'] }
        ]
      }
      expect(
        alignPlan(stored, [ruth, gehrig]).rows.map(row => row.cells)
      ).deep.equals([
        ['P', '', ''],
        ['1B', '1B', '1B']
      ])
    })

    it('reads a dash, the bench of a plan saved before it was blank, as blank', function () {
      const held = plan([[ruth, ['P', '-' as PlanCell, '']]])
      expect(alignPlan(held, [ruth]).rows[0].cells).deep.equals(['P', '', ''])
    })
  })

  describe('asGamePlan', function () {
    const sent = (cells: string[][], enabled: boolean): unknown => ({
      enabled,
      innings: cells[0].length,
      rows: cells.map((row, at) => ({
        player: [ruth, gehrig][at],
        cells: row
      }))
    })

    it('reads a stored dash as the bench', function () {
      expect(
        asGamePlan(
          sent(
            [
              ['P', '-', 'DH'],
              ['-', '-', '']
            ],
            true
          )
        ).rows.map(row => row.cells)
      ).deep.equals([
        ['P', '', 'DH'],
        ['', '', '']
      ])
    })

    it('is on when any cell holds a field position, whatever was sent', function () {
      expect(asGamePlan(sent([['', 'DH', 'EH']], true)).enabled).equals(false)
      expect(asGamePlan(sent([['', '', 'C']], false)).enabled).equals(true)
      expect(planHasPositions(plan([[ruth, ['', 'DH']]]))).equals(false)
      expect(planHasPositions(plan([[ruth, ['', 'RF']]]))).equals(true)
      expect(planHasPositions({ rows: [] })).equals(false)
    })

    it('refuses a cell that is no value, and rows that miss an inning', function () {
      expect(() => asGamePlan(sent([['P', 'X']], true))).throws(TypeError)
      expect(() =>
        asGamePlan({ ...(sent([['P', 'P']], true) as object), innings: 3 })
      ).throws(TypeError, 'Row 1 has 2 cells for 3 innings')
      expect(() =>
        asGamePlan({ ...(sent([['P']], true) as object), innings: 13 })
      ).throws(TypeError)
    })
  })

  it('adds a blank inning, and stops at 12', function () {
    const added = addInning(plan([[ruth, ['P', 'P']]]))
    expect(added.innings).equals(3)
    expect(added.rows[0].cells).deep.equals(['P', 'P', ''])
    const full = plan([[ruth, Array<PlanCell>(MAX_PLAN_INNINGS).fill('C')]])
    expect(addInning(full)).equals(full)
  })

  it('opens with five innings', function () {
    expect(DEFAULT_PLAN_INNINGS).equals(5)
    const five = plan([[ruth, ['P', 'P', 'P', 'P', 'P']]])
    expect(addInning(five).innings).equals(6)
  })

  it('deletes an added inning, and never one of the first five', function () {
    const nine = plan([
      [ruth, ['P', 'P', 'P', 'P', 'P', 'P', 'C', 'LF', 'RF']],
      [gehrig, ['C', 'C', 'C', 'C', 'C', 'C', 'P', '', 'DH']]
    ])
    const deleted = removeInning(nine, 8)
    expect(deleted.innings).equals(8)
    expect(deleted.rows.map(row => row.cells)).deep.equals([
      ['P', 'P', 'P', 'P', 'P', 'P', 'C', 'RF'],
      ['C', 'C', 'C', 'C', 'C', 'C', 'P', 'DH']
    ])
    expect(removeInning(removeInning(deleted, 7), 7).innings).equals(6)
    for (const inning of [0, 1, DEFAULT_PLAN_INNINGS, 10])
      expect(removeInning(nine, inning), String(inning)).equals(nine)
    // A plan saved with six innings: its sixth is an added one now.
    const six = plan([
      [ruth, ['P', 'P', 'P', 'P', 'P', 'C']],
      [gehrig, ['C', 'C', 'C', 'C', 'C', 'P']]
    ])
    const five = removeInning(six, 6)
    expect(five.innings).equals(5)
    expect(five.rows.map(row => row.cells)).deep.equals([
      ['P', 'P', 'P', 'P', 'P'],
      ['C', 'C', 'C', 'C', 'C']
    ])
  })

  it('clears every cell, which turns it off, and keeps its innings and rows', function () {
    const cleared = clearPlan(
      plan(
        [
          [ruth, ['P', '', 'DH']],
          [gehrig, ['1B']]
        ],
        3
      )
    )
    expect(cleared).deep.equals({
      enabled: false,
      innings: 3,
      rows: [
        { player: ruth, cells: ['', '', ''] },
        { player: gehrig, cells: ['', '', ''] }
      ]
    })
  })

  it('keys a player by gumboId, or by name and jersey', function () {
    expect(planPlayerKey(ruth)).equals('g:3')
    expect(planPlayerKey(mantle)).equals('n:Mantle M#7')
  })

  it('finds the planned innings: those whose column holds a field position', function () {
    expect(
      plannedInnings(
        plan([
          [ruth, ['P', '', 'DH', '', 'EH']],
          [gehrig, ['', '', 'EH', 'LF', '']]
        ])
      )
    ).deep.equals([true, false, false, true, false])
  })

  describe('planColumn and columnPlan', function () {
    const twelve: LineupPlayer = {
      gumboId: 12,
      fullName: 'Ames A',
      jersey: '12'
    }
    const alsoFour: LineupPlayer = {
      gumboId: 9,
      fullName: 'Abbot A',
      jersey: '4'
    }
    const sheet = plan([
      [twelve, ['P', 'C', '']],
      [ruth, ['C', '', 'P']],
      [gehrig, ['1B', '1B', 'C']],
      [alsoFour, ['', 'P', '1B']]
    ])

    it('answers every row with the inning’s cell, by jersey numerically and then name', function () {
      expect(planColumn(sheet, 2)).deep.equals([
        { player: ruth, cell: '' },
        { player: alsoFour, cell: 'P' },
        { player: gehrig, cell: '1B' },
        { player: twelve, cell: 'C' }
      ])
    })

    it('is empty for an inning the plan has not, and for a plan with no position', function () {
      expect(planColumn(sheet, 0)).deep.equals([])
      expect(planColumn(sheet, 4)).deep.equals([])
      expect(
        planColumn(
          plan([
            [ruth, ['', '']],
            [gehrig, ['DH', '']]
          ]),
          1
        )
      ).deep.equals([])
    })

    it('makes a column a plan of one inning that inningDefense reads at the 1st', function () {
      const one = columnPlan(planColumn(sheet, 3))
      expect(one).deep.equals({
        enabled: true,
        innings: 1,
        rows: [
          { player: ruth, cells: ['P'] },
          { player: alsoFour, cells: ['1B'] },
          { player: gehrig, cells: ['C'] },
          { player: twelve, cells: [''] }
        ]
      })
      expect(columnPlan([]).enabled).equals(false)
    })

    it('cleans a column’s cell, reading a dash as the bench and refusing anything else', function () {
      expect(asPlanColumnCell({ player: ruth, cell: '-' })).deep.equals({
        player: ruth,
        cell: ''
      })
      expect(() => asPlanColumnCell({ player: ruth, cell: 'XX' })).throws(
        TypeError
      )
    })
  })

  describe('inningDefense', function () {
    // Session ids are each player's gumboId; Mantle was made up at the field.
    const players = {
      3: { id: 3, fullName: 'Ruth B', jersey: '3', local: false },
      4: { id: 4, fullName: 'Gehrig L', jersey: '4', local: false },
      5: { id: 5, fullName: 'DiMaggio J', jersey: '5', local: false },
      70: { id: 70, fullName: 'Mantle M', jersey: '7', local: true },
      9: { id: 9, fullName: 'Berra Y', jersey: '8', local: false }
    }
    const defense = (
      given: Partial<Record<Position, number>>
    ): Record<Position, number | null> =>
      Object.fromEntries(
        POSITIONS.map(position => [position, given[position] ?? null])
      ) as Record<Position, number | null>
    const side = {
      battingOrder: [3, 4, 5, 70],
      // Berra pitches and does not bat.
      defense: defense({ P: 9, C: 3, '1B': 4, CF: 5, LF: 70 })
    }
    const column = (cells: PlanCell[]): GamePlan =>
      plan([
        [ruth, ['C', cells[0]]],
        [gehrig, ['1B', cells[1]]],
        [dimaggio, ['CF', cells[2]]],
        [mantle, ['LF', cells[3]]]
      ])

    it('moves planned batters, and keeps the holders of what nobody takes', function () {
      expect(
        inningDefense(column(['1B', 'C', 'RF', 'LF']), 2, side, players)
      ).deep.equals(defense({ P: 9, C: 4, '1B': 3, RF: 5, LF: 70 }))
    })

    it('takes a batter off the field for DH, EH and a sit', function () {
      expect(
        inningDefense(column(['DH', 'EH', '', 'LF']), 2, side, players)
      ).deep.equals(defense({ P: 9, LF: 70 }))
    })

    it('benches the blanks of a partly blank column', function () {
      // Ruth and Mantle are blank: they leave C and LF, and DiMaggio takes
      // LF. Gehrig stays at 1B.
      expect(
        inningDefense(column(['', '1B', 'LF', '']), 2, side, players)
      ).deep.equals(defense({ P: 9, '1B': 4, LF: 5 }))
    })

    it('reads a column with no field position as no instruction', function () {
      expect(inningDefense(column(['', '', '', '']), 2, side, players)).equals(
        null
      )
      expect(
        inningDefense(column(['DH', '', 'EH', '']), 2, side, players)
      ).equals(null)
    })

    it('keeps a batter with no row where he is', function () {
      // Berra bats now but has no row: Mantle's LF goes to DiMaggio, and
      // Berra keeps P.
      expect(
        inningDefense(
          column(['C', '1B', 'LF', '']),
          2,
          { ...side, battingOrder: [...side.battingOrder, 9] },
          players
        )
      ).deep.equals(defense({ P: 9, C: 3, '1B': 4, LF: 5 }))
    })

    it('gives a position planned twice to the first in batting order', function () {
      // Gehrig and Mantle are both planned at P: Gehrig takes it, and
      // Mantle keeps LF as an unplanned batter would.
      expect(
        inningDefense(column(['C', 'P', 'CF', 'P']), 2, side, players)
      ).deep.equals(defense({ P: 4, C: 3, CF: 5, LF: 70 }))
    })

    it('is null when the column changes nothing, or there is none', function () {
      const unchanged = column(['C', '1B', 'CF', 'LF'])
      expect(inningDefense(unchanged, 2, side, players)).equals(null)
      expect(inningDefense(unchanged, 3, side, players)).equals(null)
      expect(inningDefense(unchanged, 0, side, players)).equals(null)
    })

    it('finds a made-up player by name and jersey, and skips unknown ids', function () {
      const stored = plan([[{ ...mantle, gumboId: null }, ['RF']]])
      expect(
        inningDefense(
          stored,
          1,
          { battingOrder: [70, 99], defense: side.defense },
          players
        )
      ).deep.equals(defense({ P: 9, C: 3, '1B': 4, CF: 5, RF: 70 }))
    })

    it('never finds a made-up player by a real player’s stored id', function () {
      // Mantle's id at the field is 4, the gumboId Gehrig's row was stored
      // with; Gehrig is not in the game.
      const stored = plan([
        [gehrig, ['1B']],
        [mantle, ['RF']]
      ])
      expect(
        inningDefense(
          stored,
          1,
          { battingOrder: [4], defense: defense({ P: 9, LF: 4 }) },
          {
            4: { id: 4, fullName: 'Mantle M', jersey: '7', local: true },
            9: players[9]
          }
        )
      ).deep.equals(defense({ P: 9, RF: 4 }))
    })
  })
})

describe('plan position errors', function () {
  /** A plan of these rows' cells, one row per array, one cell per inning. */
  const planned = (cells: PlanCell[][]): GamePlan => ({
    enabled: true,
    innings: cells[0].length,
    rows: cells.map((row, at) => ({
      player: { gumboId: null, fullName: `Player ${at + 1}`, jersey: '' },
      cells: row
    }))
  })
  const FIELD: PlanCell[] = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']
  /** One inning: the cells given, top to bottom. */
  const inning = (...cells: PlanCell[]): GamePlan =>
    planned(cells.map(cell => [cell]))

  it('finds nothing in a plan with nothing assigned, a dash being no assignment', function () {
    expect(planPositionErrors(inning('', '', ''))).deep.equals([])
    expect(planPositionErrors({ innings: 2, rows: [] })).deep.equals([])
  })

  it('lists the required positions an inning with any assignment misses, in field order', function () {
    expect(planPositionErrors(inning('P'))).deep.equals([
      {
        inning: 1,
        missing: ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'],
        duplicated: []
      }
    ])
    // DH alone is an assignment, and fields nobody.
    expect(planPositionErrors(inning('DH', ''))).deep.equals([
      { inning: 1, missing: FIELD, duplicated: [] }
    ])
  })

  it('finds nothing in a complete, unique field, with or without DH and EH', function () {
    expect(planPositionErrors(inning(...FIELD))).deep.equals([])
    expect(
      planPositionErrors(inning(...FIELD, 'DH', 'EH', 'EH', ''))
    ).deep.equals([])
  })

  it('lists the positions two or more players hold, DH included and EH never', function () {
    expect(
      planPositionErrors(inning(...FIELD.slice(0, 8), 'RF', 'RF'))
    ).deep.equals([{ inning: 1, missing: [], duplicated: ['RF'] }])
    expect(
      planPositionErrors(inning(...FIELD, 'SS', '2B', '2B', 'DH', 'DH'))
    ).deep.equals([{ inning: 1, missing: [], duplicated: ['2B', 'SS', 'DH'] }])
    expect(planPositionErrors(inning(...FIELD, 'EH', 'EH', 'EH'))).deep.equals(
      []
    )
    // Two on the bench are no duplicate.
    expect(planPositionErrors(inning(...FIELD, '', ''))).deep.equals([])
  })

  it('names both problems of one inning, and each inning in order', function () {
    const plan = planned([
      ['P', 'DH', 'P', 'EH', ''],
      ['C', 'DH', 'C', 'EH', ''],
      ['1B', '', '1B', 'P', ''],
      ['2B', '', '2B', 'C', ''],
      ['SS', '', '3B', '1B', ''],
      ['SS', '', 'SS', '2B', ''],
      ['', '', 'LF', '3B', ''],
      ['', '', 'CF', 'SS', ''],
      ['', '', 'RF', 'LF', '']
    ])
    expect(planPositionErrors(plan)).deep.equals([
      { inning: 1, missing: ['3B', 'LF', 'CF', 'RF'], duplicated: ['SS'] },
      { inning: 2, missing: FIELD, duplicated: ['DH'] },
      { inning: 4, missing: ['CF', 'RF'], duplicated: [] }
    ])
    expect([...duplicatedCells(plan)].sort()).deep.equals([
      '0-1',
      '1-1',
      '4-0',
      '5-0'
    ])
  })

  it('reads only the plan’s innings, a short row as the bench', function () {
    const plan: GamePlan = {
      enabled: true,
      innings: 2,
      rows: [
        {
          player: { gumboId: null, fullName: 'Short', jersey: '' },
          cells: ['P', 'P', 'P'] as PlanCell[]
        },
        {
          player: { gumboId: null, fullName: 'Shorter', jersey: '' },
          cells: ['P'] as PlanCell[]
        }
      ]
    }
    expect(planPositionErrors(plan).map(error => error.inning)).deep.equals([
      1, 2
    ])
    expect([...duplicatedCells(plan)]).deep.equals(['0-0', '1-0'])
  })

  it('judges only the innings asked, for a final game that stopped short', function () {
    const plan = planned([
      ['P', 'SS', 'SS'],
      ['C', 'SS', '']
    ])
    expect(planPositionErrors(plan, 1).map(error => error.inning)).deep.equals([
      1
    ])
    expect(duplicatedCells(plan, planPositionErrors(plan, 1)).size).equals(0)
    expect(planPositionErrors(plan, 9).map(error => error.inning)).deep.equals([
      1, 2, 3
    ])
  })

  it('lists one, two, three and four values as a sentence does', function () {
    expect(positionList(['SS'])).equals('SS')
    expect(positionList(['SS', '2B'])).equals('SS and 2B')
    expect(positionList(['SS', '1B', 'CF'])).equals('SS, 1B, and CF')
    expect(positionList(['SS', '1B', 'CF', 'C'])).equals('SS, 1B, CF, and C')
  })
})
