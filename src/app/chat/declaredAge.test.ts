import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  appleAgeOf,
  isChatSurface,
  webDeclaredAge,
  withinAppleRange
} from './declaredAge'

describe('what a declared age says about chat', function () {
  it('reads a shared lower bound of 18 or more as an adult', function () {
    expect(appleAgeOf({ status: 'sharing', lowerBound: 18 })).deep.equals({
      kind: 'adult',
      lowerBound: 18
    })
    expect(appleAgeOf({ status: 'sharing', lowerBound: 21 })).deep.equals({
      kind: 'adult',
      lowerBound: 21
    })
  })

  it('reads 13 to 17 as a minor in its range, to 17 with no upper bound', function () {
    expect(
      appleAgeOf({ status: 'sharing', lowerBound: 13, upperBound: 15 })
    ).deep.equals({ kind: 'minor', lowerBound: 13, upperBound: 15 })
    expect(
      appleAgeOf({ status: 'sharing', lowerBound: 16, upperBound: 17 })
    ).deep.equals({ kind: 'minor', lowerBound: 16, upperBound: 17 })
    expect(appleAgeOf({ status: 'sharing', lowerBound: 13 })).deep.equals({
      kind: 'minor',
      lowerBound: 13,
      upperBound: 17
    })
    // An upper bound below the lower one, or of 18 or more, is no bound.
    expect(
      appleAgeOf({ status: 'sharing', lowerBound: 16, upperBound: 14 })
    ).deep.equals({ kind: 'minor', lowerBound: 16, upperBound: 17 })
    expect(
      appleAgeOf({ status: 'sharing', lowerBound: 16, upperBound: 20 })
    ).deep.equals({ kind: 'minor', lowerBound: 16, upperBound: 17 })
  })

  it('reads any other shared range as under 13, a missing lower bound included', function () {
    const under13 = { kind: 'under13' }
    expect(appleAgeOf({ status: 'sharing', upperBound: 12 })).deep.equals(
      under13
    )
    expect(appleAgeOf({ status: 'sharing', lowerBound: 12 })).deep.equals(
      under13
    )
    expect(appleAgeOf({ status: 'sharing' })).deep.equals(under13)
  })

  it('keeps a decline apart from a platform that cannot answer', function () {
    expect(appleAgeOf({ status: 'declined' })).equals('declined')
    expect(appleAgeOf({ status: 'unavailable' })).equals('none')
    expect(appleAgeOf({ status: 'unsupported' })).equals('none')
    expect(appleAgeOf({ status: 'unready' })).equals('pending')
  })

  it('reads the dev-server stand-in, with an upper bound', function () {
    expect(webDeclaredAge('')).deep.equals({ status: 'unsupported' })
    expect(appleAgeOf(webDeclaredAge(''))).equals('none')
    expect(webDeclaredAge('nope')).deep.equals({ status: 'unsupported' })
    expect(webDeclaredAge('12')).deep.equals({
      status: 'sharing',
      lowerBound: 12
    })
    expect(webDeclaredAge('13', '15')).deep.equals({
      status: 'sharing',
      lowerBound: 13,
      upperBound: 15
    })
    // An upper bound that is not a whole number at or above the lower one
    // is ignored.
    for (const upper of ['', 'x', '12'])
      expect(webDeclaredAge('13', upper), upper).deep.equals({
        status: 'sharing',
        lowerBound: 13
      })
  })

  it('narrows a year and month of birth to a minor’s Apple range', function () {
    const today = new Date('2026-11-20T12:00:00Z')
    const minor = { kind: 'minor' as const, lowerBound: 13, upperBound: 15 }
    // 14, and 16, on 20 November 2026.
    expect(withinAppleRange(minor, { year: 2012, month: 1 }, today)).equals(
      true
    )
    expect(withinAppleRange(minor, { year: 2010, month: 1 }, today)).equals(
      false
    )
    expect(withinAppleRange(minor, { year: 2014, month: 1 }, today)).equals(
      false
    )
    // Born November 2013, this month: 12 or 13, so inside.
    expect(withinAppleRange(minor, { year: 2013, month: 11 }, today)).equals(
      true
    )
    for (const apple of ['none', { kind: 'adult', lowerBound: 18 }] as const)
      expect(withinAppleRange(apple, { year: 2000, month: 1 }, today)).equals(
        true
      )
  })

  it('names the chat tab and the chat frames', function () {
    expect(isChatSurface('chat', undefined)).equals(true)
    for (const frame of [
      'conversation',
      'chatNew',
      'chatMembers',
      'chatInfo',
      'chatDevices',
      'chatLink',
      'chatReports'
    ]) {
      expect(isChatSurface('home', frame)).equals(true)
    }
    expect(isChatSurface('home', undefined)).equals(false)
    expect(isChatSurface('team', 'team')).equals(false)
    expect(isChatSurface('player', 'player')).equals(false)
  })
})
