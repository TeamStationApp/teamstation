import { expect } from 'chai'

import { nameGoesBelowControls } from './teamCardLayout'

describe('nameGoesBelowControls', function () {
  it('moves the name below a place and a gear on a narrow card', function () {
    expect(nameGoesBelowControls(true, true, 300, 384)).equals(true)
  })

  it('moves the name below a place and Follow on a narrow card', function () {
    // A follower's corner holds Follow, which is wider than the gear.
    expect(nameGoesBelowControls(true, true, 288, 384)).equals(true)
  })

  it('keeps the name beside the corner when the card is wide enough', function () {
    expect(nameGoesBelowControls(true, true, 400, 384)).equals(false)
  })

  it('keeps the name beside a lone control or a lone place', function () {
    expect(nameGoesBelowControls(false, true, 288, 384)).equals(false)
    expect(nameGoesBelowControls(true, false, 288, 384)).equals(false)
  })
})
