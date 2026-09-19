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
    expect(isShortFormOf(short('Adrian'), short('Adrian', 'Hardy'))).equals(
      true
    )
    expect(
      isShortFormOf(short('Findon', 'R'), short('Findon', 'Rogers'))
    ).equals(true)
    expect(isShortFormOf(short('aiden'), short('Aiden', 'Michels'))).equals(
      true
    )
  })

  it('knows a first name somebody stopped typing', function () {
    // `Dom` on the Black Sox beside `Dominick Vela`, both in #12, and the
    // short row has no surname at all to go on.
    expect(
      isShortFormOf(
        { firstName: 'Dom', lastName: '' },
        { firstName: 'Dominick', lastName: 'Vela' }
      )
    ).equals(true)
    // But not when the short row claims a surname of its own: that is a
    // different child with a shorter first name.
    expect(
      isShortFormOf(
        { firstName: 'Dom', lastName: 'Ruiz' },
        { firstName: 'Dominick', lastName: 'Vela' }
      )
    ).equals(false)
    // And a nickname is not a truncation. `Toby` is nobody's prefix.
    expect(
      isShortFormOf(
        { firstName: 'Toby', lastName: '' },
        { firstName: 'Tobias', lastName: 'Minami' }
      )
    ).equals(false)
  })

  it('does not pair two rows of the same name', function () {
    // The Black Sox have two boys called Ben, in shirts 2 and 5. Neither is
    // the other's short form, or both would be closed into nothing.
    const ben = { firstName: 'Ben', lastName: '' }
    expect(isShortFormOf(ben, { ...ben })).equals(false)
    expect(
      isShortFormOf(
        { firstName: 'Wesley', lastName: 'Boren' },
        { firstName: 'Wesley', lastName: 'Boren' }
      )
    ).equals(false)
  })

  it('does not pair two different children', function () {
    expect(
      isShortFormOf(
        { firstName: 'Isaac', lastName: '' },
        { firstName: 'Ivan', lastName: 'Davis' }
      )
    ).equals(false)
    expect(
      isShortFormOf(
        { firstName: 'Findon', lastName: 'S' },
        { firstName: 'Findon', lastName: 'Rogers' }
      )
    ).equals(false)
  })

  it('needs a first name to go on', function () {
    expect(
      isShortFormOf(
        { firstName: '', lastName: '' },
        { firstName: '', lastName: 'Rogers' }
      )
    ).equals(false)
  })
})
