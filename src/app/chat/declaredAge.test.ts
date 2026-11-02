import { expect } from 'chai'
import { describe, it } from 'mocha'

import { chatGate, isChatSurface, webDeclaredAge } from './declaredAge'

describe('declared age chat gate', function () {
  it('allows a shared lower bound of at least 13', function () {
    expect(chatGate({ status: 'sharing', lowerBound: 13 })).equals('allowed')
    expect(
      chatGate({ status: 'sharing', lowerBound: 13, upperBound: 15 })
    ).equals('allowed')
    expect(chatGate({ status: 'sharing', lowerBound: 18 })).equals('allowed')
  })

  it('denies a decline or a range under 13', function () {
    expect(chatGate({ status: 'sharing', upperBound: 12 })).equals('denied')
    expect(chatGate({ status: 'sharing', lowerBound: 12 })).equals('denied')
    expect(chatGate({ status: 'sharing' })).equals('denied')
    expect(chatGate({ status: 'declined' })).equals('denied')
  })

  it('keeps chat when the platform cannot return a range', function () {
    expect(chatGate({ status: 'unavailable' })).equals('allowed')
    expect(chatGate({ status: 'unsupported' })).equals('allowed')
    expect(chatGate({ status: 'unready' })).equals('pending')
  })

  it('reads the dev-server stand-in', function () {
    expect(webDeclaredAge('')).deep.equals({ status: 'unsupported' })
    expect(chatGate(webDeclaredAge(''))).equals('allowed')
    expect(webDeclaredAge('nope')).deep.equals({ status: 'unsupported' })
    expect(chatGate(webDeclaredAge('12'))).equals('denied')
    expect(webDeclaredAge('12')).deep.equals({
      status: 'sharing',
      lowerBound: 12
    })
    expect(chatGate(webDeclaredAge('13'))).equals('allowed')
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
