import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { LineupPlayer } from './api'
import {
  addInning,
  alignPlan,
  asGamePlan,
  clearPlan,
  completeCell,
  DEFAULT_PLAN_INNINGS,
  type GamePlan,
  inningDefense,
  MAX_PLAN_INNINGS,
  PLAN_CELLS,
  type PlanCell,
  planCellEntry,
  planCellOf,
  planHasPositions,
  plannedInnings,
  planPlayerKey,
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
