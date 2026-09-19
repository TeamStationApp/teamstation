import { expect } from 'chai'
import { describe, it } from 'mocha'

import { actionFor, isShortFormOf } from './duplicatePeople'

describe('two rows for one child', function () {
  it('does not keep a row with nothing on it', function () {
    expect(actionFor(0, 120)).equals('drop')
    expect(actionFor(120, 0)).equals('drop')
  })

  it('merges when both have a history', function () {
    expect(actionFor(13, 101)).equals('merge')
    expect(actionFor(1, 1)).equals('merge')
  })

  it('drops rather than merges when neither has anything', function () {
    expect(actionFor(0, 0)).equals('drop')
  })

  it('knows a name somebody stopped typing', function () {
    const short = (
      firstName: string,
      lastName = ''
    ): { firstName: string; lastName: string } => ({ firstName, lastName })
    // A missing surname and one cut to its initial are the same thing.
    expect(isShortFormOf(short('Adrian'), short('Adrian', 'Houser'))).equals(
      true
    )
    expect(
      isShortFormOf(short('Anthony', 'R'), short('Anthony', 'Rizzo'))
    ).equals(true)
    expect(isShortFormOf(short('aaron'), short('Aaron', 'Sanchez'))).equals(
      true
    )
  })

  it('does not pair two rows of the same name', function () {
    // The Bay Stars have two boys called Ben, in shirts 2 and 5. Neither is
    // the other's short form, or both would be closed into nothing.
    const ben = { firstName: 'Ben', lastName: '' }
    expect(isShortFormOf(ben, { ...ben })).equals(false)
    expect(
      isShortFormOf(
        { firstName: 'Casey', lastName: 'Mize' },
        { firstName: 'Casey', lastName: 'Mize' }
      )
    ).equals(false)
  })

  it('does not pair two different children', function () {
    expect(
      isShortFormOf(
        { firstName: 'Isaac', lastName: '' },
        { firstName: 'Ivan', lastName: 'Castillo' }
      )
    ).equals(false)
    expect(
      isShortFormOf(
        { firstName: 'Anthony', lastName: 'S' },
        { firstName: 'Anthony', lastName: 'Rizzo' }
      )
    ).equals(false)
  })

  it('needs a first name to go on', function () {
    expect(
      isShortFormOf(
        { firstName: '', lastName: '' },
        { firstName: '', lastName: 'Rizzo' }
      )
    ).equals(false)
  })
})
