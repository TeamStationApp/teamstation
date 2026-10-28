import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  claimsSwipe,
  COMMIT_FRACTION,
  commitsSwipe,
  FLICK_PX_PER_MS,
  followOf
} from './sheetSwipe'

describe("the phone's sheet and the finger that pulls it down", function () {
  it('takes a move once it is past the tap slop downwards and mostly down', function () {
    expect(claimsSwipe(2, 20)).equals(true)
    expect(claimsSwipe(-9, 20)).equals(true)
    // Sideways as much as down: a scrub or a carried tile's.
    expect(claimsSwipe(20, 20)).equals(false)
    expect(claimsSwipe(11, 20)).equals(false)
    // Short of the slop, or upwards.
    expect(claimsSwipe(0, 5)).equals(false)
    expect(claimsSwipe(0, -30)).equals(false)
  })

  it('closes past a quarter of the screen, or on a flick, and springs back otherwise', function () {
    expect(COMMIT_FRACTION).equals(0.25)
    expect(FLICK_PX_PER_MS).equals(0.8)
    expect(commitsSwipe(201, 0, 800)).equals(true)
    expect(commitsSwipe(199, 0, 800)).equals(false)
    expect(commitsSwipe(40, 0.9, 800)).equals(true)
    expect(commitsSwipe(40, 0.7, 800)).equals(false)
  })

  it('follows the finger down, never above where the sheet sits', function () {
    expect(followOf(120)).equals(120)
    expect(followOf(-40)).equals(0)
  })
})
