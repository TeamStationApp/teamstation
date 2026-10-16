import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asJersey,
  asNewRosterPlayer,
  asPlayerPositions,
  asPlayerSettings,
  PLAYER_POSITIONS
} from './playerSettings'

describe('a player’s settings', function () {
  it('validates trimmed name parts and refuses empty, malformed or oversized names', function () {
    expect(
      asPlayerSettings({ name: { firstName: ' Mookie ', lastName: ' Betts ' } })
    ).deep.equals({ name: { firstName: 'Mookie', lastName: 'Betts' } })
    expect(
      asPlayerSettings({ name: { firstName: '', lastName: 'Betts' } })
    ).deep.equals({ name: { firstName: '', lastName: 'Betts' } })
    expect(
      asPlayerSettings({ name: { firstName: 'Mookie', lastName: '' } })
    ).deep.equals({ name: { firstName: 'Mookie', lastName: '' } })
    for (const name of [
      null,
      [],
      'Mookie',
      {},
      { firstName: null, lastName: 'Betts' },
      { firstName: 'Mookie', lastName: 2 },
      { firstName: ' ', lastName: ' ' },
      { firstName: 'M'.repeat(101), lastName: 'Betts' },
      { firstName: 'Mookie', lastName: 'B'.repeat(101) }
    ]) {
      expect(() => asPlayerSettings({ name }), JSON.stringify(name)).throws()
    }
  })
  it('offers the nine fielding positions and the designated hitter', function () {
    expect(PLAYER_POSITIONS).deep.equals([
      'P',
      'C',
      '1B',
      '2B',
      'SS',
      '3B',
      'LF',
      'CF',
      'RF',
      'DH'
    ])
  })

  it('stores a jersey trimmed, and an empty one as none', function () {
    expect(asJersey(' 12 ')).equals('12')
    expect(asJersey('')).equals(null)
    expect(asJersey(null)).equals(null)
    expect(() => asJersey('1234')).throws('at most 3')
    expect(() => asJersey(12)).throws()
  })

  it('keeps each position once, in field order', function () {
    expect(asPlayerPositions(['DH', 'SS', '2B', 'SS'])).deep.equals([
      '2B',
      'SS',
      'DH'
    ])
    expect(asPlayerPositions([])).deep.equals([])
    expect(() => asPlayerPositions(['OF'])).throws('Not a position')
    expect(() => asPlayerPositions('SS')).throws()
  })

  it('reads only the fields sent, and refuses a body that sends none', function () {
    expect(asPlayerSettings({ bats: 'switch' })).deep.equals({ bats: 'switch' })
    expect(
      asPlayerSettings({
        jersey: null,
        positions: ['C'],
        bats: null,
        throws: 'left',
        other: true
      })
    ).deep.equals({
      jersey: null,
      positions: ['C'],
      bats: null,
      throws: 'left'
    })
    expect(() => asPlayerSettings({})).throws('Nothing to change')
    expect(() => asPlayerSettings([])).throws('Expected an object')
    expect(() => asPlayerSettings(null)).throws('Expected an object')
    expect(() => asPlayerSettings({ jersey: '1234' })).throws('jersey: ')
    expect(() => asPlayerSettings({ bats: 'both' })).throws()
    expect(() => asPlayerSettings({ throws: 'switch' })).throws()
  })

  it('requires a name and the roster fields when creating a player', function () {
    expect(
      asNewRosterPlayer({
        firstName: ' Alex ',
        lastName: ' Lee ',
        jersey: ' 7 ',
        positions: ['SS', 'SS', 'DH'],
        bats: 'switch',
        throws: 'left'
      })
    ).deep.equals({
      firstName: 'Alex',
      lastName: 'Lee',
      jersey: '7',
      positions: ['SS', 'DH'],
      bats: 'switch',
      throws: 'left'
    })
    expect(() =>
      asNewRosterPlayer({
        firstName: ' ',
        lastName: '',
        jersey: null,
        positions: [],
        bats: null,
        throws: null
      })
    ).throws('Enter a player name.')
    expect(() =>
      asNewRosterPlayer({
        firstName: 'Alex',
        lastName: 'Lee',
        jersey: null,
        positions: ['EH'],
        bats: 'right',
        throws: 'right'
      })
    ).throws('positions:')
  })
})
