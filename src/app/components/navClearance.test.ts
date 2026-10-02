import { expect } from 'chai'
import { describe, it } from 'mocha'

import { floatingNavBottom, navClearanceAboveInset } from './navClearance'

const margin = 16
const inset = 34
const clearance = 120

describe('the floating nav and the unsafe area', function () {
  it('sits the iOS capsule on the home-indicator inset', function () {
    expect(floatingNavBottom('ios', margin, inset)).equals(inset)
    expect(navClearanceAboveInset('ios', clearance, margin)).equals(
      clearance - margin
    )
  })

  it('keeps Android a margin above its navigation inset', function () {
    expect(floatingNavBottom('android', margin, inset)).equals(margin + inset)
    expect(navClearanceAboveInset('android', clearance, margin)).equals(
      clearance
    )
  })

  it('keeps the browser on the designed margin, with no inset to add', function () {
    expect(floatingNavBottom('web', margin, 0)).equals(margin)
    expect(navClearanceAboveInset('web', clearance, margin)).equals(clearance)
  })
})
