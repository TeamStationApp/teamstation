import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  floatingNavBottom,
  navContentBottom,
  offlineBannerBottom
} from './navClearance'

const margin = 16
const inset = 34

describe('the floating nav and the unsafe area', function () {
  it('aligns the reference capsule with the 83-point UIKit host and lifts it above a banner', function () {
    const height = 62
    const hostHeight = 49 + inset
    const gap = floatingNavBottom('ios', margin, inset)
    expect(gap).equals(21)
    expect(height + gap).equals(hostHeight)
    const withBanner = floatingNavBottom('ios', margin, inset, 40)
    expect(navContentBottom('ios', margin, inset)).equals(gap)
    expect(navContentBottom('ios', margin, inset, 40)).equals(withBanner)
    expect(navContentBottom('android', margin, inset, 40)).equals(
      margin + inset + 40
    )
    expect(withBanner - gap).equals(40)
    expect(height + withBanner).equals(hostHeight + 40)
    expect(floatingNavBottom('ios', margin, 0)).equals(0)
  })

  it('keeps Android a margin above its navigation inset', function () {
    expect(floatingNavBottom('android', margin, inset)).equals(margin + inset)
  })

  it('keeps the browser on the designed margin, with no inset to add', function () {
    expect(floatingNavBottom('web', margin, 0)).equals(margin)
  })

  it('sits the capsule on the offline banner, which sits on the inset or, on iOS, the resting glass edge', function () {
    for (const platform of ['android', 'web'])
      expect(floatingNavBottom(platform, margin, inset, 40), platform).equals(
        inset + 40
      )
    expect(offlineBannerBottom('android', inset)).equals(inset)
    expect(offlineBannerBottom('web', 0)).equals(0)
    expect(offlineBannerBottom('ios', inset)).equals(21)
    expect(offlineBannerBottom('ios', 0)).equals(0)
    expect(floatingNavBottom('ios', margin, inset, 40)).equals(21 + 40)
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
    expect(floatingNavBottom('ios', margin, inset, 1)).equals(21 + 1)
  })

  it('moves every bar variant with the strip from its first frame, with no step and no overlap', function () {
    const variants: Array<[string, number]> = [
      ['ios', inset],
      ['ios', 0],
      ['android', inset],
      ['android', 0],
      ['web', 0]
    ]
    for (const [platform, bottomInset] of variants) {
      let previous = floatingNavBottom(platform, margin, bottomInset)
      for (let banner = 0.5; banner <= 48; banner += 0.5) {
        const bottom = floatingNavBottom(platform, margin, bottomInset, banner)
        const label = `${platform} inset ${bottomInset} banner ${banner}`
        // The platter never covers the strip's top edge.
        expect(bottom, label).at.least(
          offlineBannerBottom(platform, bottomInset) + banner
        )
        // Half a point of strip moves the platter at most half a point.
        expect(bottom - previous, label).within(0, 0.5)
        // Content clears the platter as it moves.
        expect(
          navContentBottom(platform, margin, bottomInset, banner),
          label
        ).at.least(bottom)
        previous = bottom
      }
    }
  })
})
