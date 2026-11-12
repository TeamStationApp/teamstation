import { expect } from 'chai'
import { describe, it } from 'mocha'

import { liftWasLost } from './heldTouch'

describe('a phone grid’s followed finger', function () {
  it('has lifted unseen when the fingers on the glass no longer include it', function () {
    // The next touch, alone on the glass: the held one's lift was lost.
    expect(liftWasLost(3, [{ identifier: 4 }])).equals(true)
    expect(liftWasLost(3, [])).equals(true)
  })

  it('is still down while it is listed, beside a second finger or alone', function () {
    expect(liftWasLost(3, [{ identifier: 3 }, { identifier: 4 }])).equals(false)
    expect(liftWasLost(3, [{ identifier: '3' }])).equals(false)
  })

  it('says nothing without a followed finger, or a list of fingers', function () {
    expect(liftWasLost(null, [{ identifier: 4 }])).equals(false)
    expect(liftWasLost(3, undefined)).equals(false)
  })
})
