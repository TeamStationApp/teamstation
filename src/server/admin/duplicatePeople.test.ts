import { expect } from 'chai'
import { describe, it } from 'mocha'

import { actionFor, isShortFormOf, shirtPairs } from './duplicatePeople'

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

  it('knows a first name somebody stopped typing', function () {
    // `Dom` on the Bay Stars beside `Domingo Santana`, both in #12, and the
    // short row has no surname at all to go on.
    expect(
      isShortFormOf(
        { firstName: 'Dom', lastName: '' },
        { firstName: 'Domingo', lastName: 'Santana' }
      )
    ).equals(true)
    // But not when the short row claims a surname of its own: that is a
    // different child with a shorter first name.
    expect(
      isShortFormOf(
        { firstName: 'Dom', lastName: 'DiMaggio' },
        { firstName: 'Domingo', lastName: 'Santana' }
      )
    ).equals(false)
    // And a nickname is not a truncation. `Ned` is nobody's prefix.
    expect(
      isShortFormOf(
        { firstName: 'Ned', lastName: '' },
        { firstName: 'Edward', lastName: 'Olivares' }
      )
    ).equals(false)
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

  it('joins an empty row to the shirt it shares', function () {
    // `Ned` #7 has 72 plays and `Edward Olivares` #7 has none: one roster spot,
    // and no rule can read a nickname.
    const [ned, edward, other] = [1, 2, 3]
    const found = shirtPairs([
      { userId: ned, displayName: 'Ned', jersey: '7', plays: 72 },
      { userId: edward, displayName: 'Edward Olivares', jersey: '7', plays: 0 },
      { userId: other, displayName: 'Somebody', jersey: '3', plays: 12 }
    ])
    expect(found.length).equals(1)
    expect(found[0].keepUserId).equals(ned)
    expect(found[0].emptyUserId).equals(edward)
  })

  it('leaves a shirt two children have both played in', function () {
    // Eleven numbers on the server are worn by two children who both played.
    expect(
      shirtPairs([
        { userId: 1, displayName: 'Aaron A', jersey: '13', plays: 40 },
        { userId: 2, displayName: 'Jack A', jersey: '13', plays: 12 }
      ])
    ).deep.equals([])
    // And a shirt three rows claim says nothing at all.
    expect(
      shirtPairs([
        { userId: 1, displayName: 'A', jersey: '5', plays: 10 },
        { userId: 2, displayName: 'B', jersey: '5', plays: 0 },
        { userId: 3, displayName: 'C', jersey: '5', plays: 0 }
      ])
    ).deep.equals([])
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
