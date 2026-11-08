import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { LineupPlayer } from './api'
import {
  addInning,
  alignPlan,
  clearPlan,
  DEFAULT_PLAN_INNINGS,
  type GamePlan,
  inningDefense,
  MAX_PLAN_INNINGS,
  PLAN_CELLS,
  type PlanCell,
  planCellEntry,
  planCellOf,
  planPlayerKey,
  planRowCounts
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
    })

    it('refuses anything else, and text longer than a cell', function () {
      for (const text of ['X', '1', 'SSS', 'LF ', 'Q', 'S', 'CC', 'P1', '--'])
        expect(planCellOf(text), text).equals(null)
    })
  })

  describe('planCellEntry', function () {
    it('commits whole values', function () {
      expect(planCellEntry('', 'ss')).deep.equals({ commit: 'SS' })
      expect(planCellEntry('', 'P')).deep.equals({ commit: 'P' })
      expect(planCellEntry('', '-')).deep.equals({ commit: '-' })
      expect(planCellEntry('LF', '')).deep.equals({ commit: '' })
      // C commits at once, and F after it makes CF.
      expect(planCellEntry('', 'c')).deep.equals({ commit: 'C' })
      expect(planCellEntry('C', 'CF')).deep.equals({ commit: 'CF' })
      expect(planCellEntry('S', 'Ss')).deep.equals({ commit: 'SS' })
      expect(planCellEntry('1', '1b')).deep.equals({ commit: '1B' })
    })

    it('holds each prefix as pending', function () {
      for (const prefix of ['S', '1', '2', '3', 'L', 'R', 'D', 'E'])
        expect(planCellEntry('', prefix.toLowerCase())).deep.equals({
          pending: prefix
        })
      // A key after a one-letter value that makes nothing with it starts
      // over.
      expect(planCellEntry('P', 'Ps')).deep.equals({ pending: 'S' })
      expect(planCellEntry('-', '-l')).deep.equals({ pending: 'L' })
    })

    it('refuses what starts no value', function () {
      for (const [previous, text] of [
        ['', 'X'],
        ['', 'q'],
        ['S', 'SX'],
        ['1', '1C'],
        ['P', 'PX'],
        ['SS', 'SSS'],
        ['', 'S  ']
      ])
        expect(planCellEntry(previous, text), text).deep.equals({
          refuse: true
        })
    })
  })

  describe('alignPlan', function () {
    it('follows the batting order, matching by gumboId and by name and jersey', function () {
      const stored = plan([
        [ruth, ['P', 'P', 'P']],
        [mantle, ['CF', 'CF', 'LF']],
        [gehrig, ['1B', '1B', '-']]
      ])
      // Gehrig's name reads differently now; Mantle has no gumboId.
      const renamed = { ...gehrig, fullName: 'Gehrig H L' }
      const aligned = alignPlan(stored, [renamed, ruth, mantle, dimaggio])
      expect(aligned.enabled).equals(true)
      expect(aligned.innings).equals(3)
      expect(aligned.rows).deep.equals([
        { player: renamed, cells: ['1B', '1B', '-'] },
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
  })

  it('adds a blank inning, and stops at 12', function () {
    const added = addInning(plan([[ruth, ['P', 'P']]]))
    expect(added.innings).equals(3)
    expect(added.rows[0].cells).deep.equals(['P', 'P', ''])
    const full = plan([[ruth, Array<PlanCell>(MAX_PLAN_INNINGS).fill('C')]])
    expect(addInning(full)).equals(full)
  })

  it('clears every cell and keeps the toggle, innings and rows', function () {
    const cleared = clearPlan(
      plan(
        [
          [ruth, ['P', '-', 'DH']],
          [gehrig, ['1B']]
        ],
        3
      )
    )
    expect(cleared).deep.equals({
      enabled: true,
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

  it('counts a row’s innings at each field position, and its sits', function () {
    expect(
      planRowCounts(['P', 'C', 'SS', 'LF', 'RF', 'SS', '-', 'DH', 'EH', ''])
    ).deep.equals({
      positions: {
        P: 1,
        C: 1,
        '1B': 0,
        '2B': 0,
        SS: 2,
        '3B': 0,
        LF: 1,
        CF: 0,
        RF: 1
      },
      sits: 1
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
        inningDefense(column(['DH', 'EH', '-', 'LF']), 2, side, players)
      ).deep.equals(defense({ P: 9, LF: 70 }))
    })

    it('reads a blank as no instruction', function () {
      // Ruth is unplanned and keeps C; Mantle is unplanned and loses LF to
      // DiMaggio.
      expect(
        inningDefense(column(['', '1B', 'LF', '']), 2, side, players)
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
      expect(inningDefense(column(['', '', '', '']), 2, side, players)).equals(
        null
      )
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
