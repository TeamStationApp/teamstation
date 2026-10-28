import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asExistingRosterPlayer,
  asJersey,
  asNewRosterPlayer,
  asPlayerPositions,
  asPlayerSettings,
  asRosterPlayerBody,
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
    for (const invalid of [null, [], 'player', 7])
      expect(() => asNewRosterPlayer(invalid)).throws('Expected an object')
    expect(
      asNewRosterPlayer({
        firstName: ' Cliff ',
        lastName: ' Lee ',
        jersey: ' 7 ',
        positions: ['SS', 'SS', 'DH'],
        bats: 'switch',
        throws: 'left'
      })
    ).deep.equals({
      firstName: 'Cliff',
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
        firstName: 'Cliff',
        lastName: 'Lee',
        jersey: null,
        positions: ['EH'],
        bats: 'right',
        throws: 'right'
      })
    ).throws('positions:')
  })
})

describe('a player who already exists, by id', function () {
  it('takes only a jersey and positions beside the id, and the keys the route reads', function () {
    expect(asExistingRosterPlayer({ userId: 'usr_a' })).deep.equals({
      userId: 'usr_a',
      jersey: null,
      positions: []
    })
    expect(
      asExistingRosterPlayer(
        { userId: 'usr_a', jersey: ' 50 ', positions: ['RF'], side: 'home' },
        ['side', 'teamId']
      )
    ).deep.equals({ userId: 'usr_a', jersey: '50', positions: ['RF'] })
    for (const key of [
      'firstName',
      'lastName',
      'bats',
      'throws',
      'externalId',
      'side'
    ])
      expect(() =>
        asExistingRosterPlayer({ userId: 'usr_a', [key]: 'x' })
      ).throws(`${key} is not allowed with userId`)
    expect(() => asExistingRosterPlayer({ userId: '' })).throws('userId')
    expect(() => asExistingRosterPlayer({ userId: 7 })).throws('userId')
    expect(() => asExistingRosterPlayer(null)).throws('Expected an object')
    expect(() =>
      asExistingRosterPlayer({ userId: 'usr_a', jersey: '1234' })
    ).throws()
  })

  it('reads a roster body as an existing player when it names one, and as a new one otherwise', function () {
    expect(asRosterPlayerBody({ userId: 'usr_a' })).deep.equals({
      existing: { userId: 'usr_a', jersey: null, positions: [] }
    })
    const player = {
      firstName: 'Max',
      lastName: 'Muncy',
      jersey: '13',
      positions: ['3B'],
      bats: 'left',
      throws: 'right'
    }
    expect(asRosterPlayerBody(player)).deep.equals({
      player: asNewRosterPlayer(player)
    })
  })
})
