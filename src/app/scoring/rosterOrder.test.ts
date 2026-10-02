import { expect } from 'chai'
import { describe, it } from 'mocha'

import { byJersey, type RosterOrderPlayer } from './rosterOrder'

function roster(
  rows: Array<[number, string, string]>
): Record<number, RosterOrderPlayer> {
  return Object.fromEntries(
    rows.map(([id, jersey, fullName]) => [id, { jersey, fullName }])
  )
}

describe('roster order by jersey', function () {
  it('puts numbers first, lowest first, by value rather than text', function () {
    const players = roster([
      [1, '10', 'Ten'],
      [2, '2', 'Two'],
      [3, '1', 'One'],
      [4, '21', 'Twenty-one']
    ])
    expect(byJersey([1, 2, 3, 4], players)).deep.equals([3, 2, 1, 4])
  })

  it('puts 0 before 00, and equal numbers by name, then by id', function () {
    const players = roster([
      [1, '00', 'Zero Zero'],
      [2, '0', 'Zero'],
      [3, '7', 'Bea'],
      [4, '7', 'Al'],
      [5, '7', 'Al']
    ])
    expect(byJersey([5, 1, 3, 4, 2], players)).deep.equals([2, 1, 4, 5, 3])
  })

  it('puts other jersey text after numbers and players with no number last', function () {
    const players = roster([
      [1, '', 'Zed'],
      [2, 'A2', 'Ace'],
      [3, 'A10', 'Axe'],
      [4, '  ', 'Amy'],
      [5, '3', 'Cal'],
      [6, 'B', 'Bo'],
      [7, '', 'Amy']
    ])
    expect(byJersey([1, 2, 3, 4, 5, 6, 7], players)).deep.equals([
      5, 2, 3, 6, 4, 7, 1
    ])
  })

  it('leaves the list it was given alone', function () {
    const ids = [2, 1]
    const players = roster([
      [1, '1', 'One'],
      [2, '2', 'Two']
    ])
    expect(byJersey(ids, players)).deep.equals([1, 2])
    expect(ids).deep.equals([2, 1])
  })
})
