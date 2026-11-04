import { expect } from 'chai'
import { describe, it } from 'mocha'

import { appleAgeOf, isChatSurface, webDeclaredAge } from './declaredAge'

describe('what a declared age says about chat', function () {
  it('reads a shared lower bound of at least 13 as 13 or older', function () {
    expect(appleAgeOf({ status: 'sharing', lowerBound: 13 })).equals('over13')
    expect(
      appleAgeOf({ status: 'sharing', lowerBound: 13, upperBound: 15 })
    ).equals('over13')
    expect(appleAgeOf({ status: 'sharing', lowerBound: 18 })).equals('over13')
  })

  it('reads any other shared range as under 13, a missing lower bound included', function () {
    expect(appleAgeOf({ status: 'sharing', upperBound: 12 })).equals('under13')
    expect(appleAgeOf({ status: 'sharing', lowerBound: 12 })).equals('under13')
    expect(appleAgeOf({ status: 'sharing' })).equals('under13')
  })

  it('keeps a decline apart from a platform that cannot answer', function () {
    expect(appleAgeOf({ status: 'declined' })).equals('declined')
    expect(appleAgeOf({ status: 'unavailable' })).equals('none')
    expect(appleAgeOf({ status: 'unsupported' })).equals('none')
    expect(appleAgeOf({ status: 'unready' })).equals('pending')
  })

  it('reads the dev-server stand-in', function () {
    expect(webDeclaredAge('')).deep.equals({ status: 'unsupported' })
    expect(appleAgeOf(webDeclaredAge(''))).equals('none')
    expect(webDeclaredAge('nope')).deep.equals({ status: 'unsupported' })
    expect(appleAgeOf(webDeclaredAge('12'))).equals('under13')
    expect(webDeclaredAge('12')).deep.equals({
      status: 'sharing',
      lowerBound: 12
    })
    expect(appleAgeOf(webDeclaredAge('13'))).equals('over13')
    expect(webDeclaredAge('13')).deep.equals({
      status: 'sharing',
      lowerBound: 13
    })
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
