import { expect } from 'chai'
import { describe, it } from 'mocha'

import { CARD_HIDE_MS, cardSeekTarget } from './cardScrub'

describe("the event card's scrub line", function () {
  it('seeks across the length of a recording', function () {
    const video = { duration: 600, seekableEnd: null }
    expect(cardSeekTarget(0, video)).equals(0)
    expect(cardSeekTarget(0.5, video)).equals(300)
    expect(cardSeekTarget(1, video)).equals(600)
    expect(cardSeekTarget(1.4, video)).equals(600)
    expect(cardSeekTarget(-1, video)).equals(0)
  })

  it('seeks across what can be reached of a live one, and nowhere before it is known', function () {
    expect(
      cardSeekTarget(0.25, { duration: Infinity, seekableEnd: 400 })
    ).equals(100)
    expect(
      cardSeekTarget(0.25, { duration: Number.NaN, seekableEnd: null })
    ).equals(null)
  })

  it('hides its controls a second on', function () {
    expect(CARD_HIDE_MS).equals(1000)
  })
})
