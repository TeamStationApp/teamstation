import { expect } from 'chai'
import { describe, it } from 'mocha'

import { emptyPlayerForm, playerFormError } from './playerForm'

describe('playerFormError', function () {
  const form = {
    ...emptyPlayerForm(),
    firstName: 'Walker',
    lastName: 'Buehler'
  }

  it('asks for a name only where the form sets it', function () {
    const nameless = { ...form, firstName: ' ', lastName: '' }
    expect(playerFormError(nameless, { nameRequired: true })).equals(
      'Enter a player name.'
    )
    expect(playerFormError(nameless, { nameRequired: false })).equals(undefined)
    expect(
      playerFormError(
        { ...nameless, lastName: 'Muncy' },
        { nameRequired: true }
      )
    ).equals(undefined)
  })

  it('takes a jersey of up to three digits, or none', function () {
    for (const jersey of ['', ' 21 ', '999'])
      expect(
        playerFormError({ ...form, jersey }, { nameRequired: true })
      ).equals(undefined)
    expect(
      playerFormError({ ...form, jersey: '2a' }, { nameRequired: true })
    ).equals('Use digits for the jersey number.')
    expect(
      playerFormError({ ...form, jersey: '1234' }, { nameRequired: true })
    ).equals('A jersey number is at most 3 characters.')
  })

  it('starts blank, throwing and batting right', function () {
    expect(emptyPlayerForm()).deep.equals({
      firstName: '',
      lastName: '',
      jersey: '',
      throws: 'right',
      bats: 'right',
      positions: []
    })
  })
})
