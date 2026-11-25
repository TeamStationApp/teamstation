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

  it('sits the capsule on the offline banner, which sits on the inset', function () {
    for (const platform of ['ios', 'android', 'web'])
      expect(floatingNavBottom(platform, margin, inset, 40), platform).equals(
        inset + 40
      )
    expect(floatingNavBottom('android', margin, inset, 0)).equals(
      margin + inset
    )
  })

  it('keeps the minimum capsule margin continuously as the strip slides past it', function () {
    for (const platform of ['web', 'android'])
      expect(
        [0, 1, 15, 16, 17, 34].map(height =>
          floatingNavBottom(platform, margin, 0, height)
        )
      ).deep.equals([16, 16, 16, 16, 17, 34])
    expect(floatingNavBottom('ios', margin, inset, 1)).equals(inset + 1)
  })
})
