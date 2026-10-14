import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ChatDmPerson, ChatMember } from '../../../common/api'
import { dmTitle } from './engine'

/** U12: a DM's name, from the people in it with you. */
describe('a DM’s name', function () {
  const me = 1

  const member = (userId: number, shortName: string): ChatMember => ({
    userId,
    shortName,
    avatarUrl: null,
    label: 'Member',
    isModerator: false,
    isApprover: true,
    eligible: true,
    hasIdentity: true,
    identityKey: null,
    generation: 1
  })

  const person = (
    userId: number,
    shortName: string,
    left = false
  ): ChatDmPerson => ({ userId, shortName, left, avatarUrl: null })

  it('names the others who are in it now', function () {
    const people = [person(2, 'Eli C'), person(3, 'Blair B')]
    expect(dmTitle(me, undefined, people)).equals('Eli C, Blair B')
    expect(
      dmTitle(me, [member(me, 'Dana D'), member(2, 'Eli C')], people)
    ).equals('Eli C')
  })

  it('names only those still there when some have left', function () {
    const people = [person(2, 'Eli C', true), person(3, 'Blair B')]
    expect(dmTitle(me, undefined, people)).equals('Blair B')
    expect(
      dmTitle(me, [member(me, 'Dana D'), member(3, 'Blair B')], people)
    ).equals('Blair B')
  })

  it('names the people who left, marked, once they all have', function () {
    expect(dmTitle(me, undefined, [person(2, 'Eli C', true)])).equals(
      'Eli C (left)'
    )
    expect(
      dmTitle(
        me,
        [member(me, 'Dana D')],
        [person(3, 'Blair B', true), person(2, 'Eli C', true)]
      )
    ).equals('Blair B (left), Eli C (left)')
  })

  it('trusts the members it has read over a list that has not caught up', function () {
    // The list still says Eli C is in it; the members say otherwise.
    expect(dmTitle(me, [member(me, 'Dana D')], [person(2, 'Eli C')])).equals(
      'Eli C (left)'
    )
    // Somebody added since the list was read is named all the same.
    expect(dmTitle(me, [member(me, 'Dana D'), member(4, 'Kim K')], [])).equals(
      'Kim K'
    )
  })

  it('is "Just you" when nobody else was ever in it', function () {
    expect(dmTitle(me, undefined, [])).equals('Just you')
    expect(dmTitle(me, [member(me, 'Dana D')], [])).equals('Just you')
  })
})
