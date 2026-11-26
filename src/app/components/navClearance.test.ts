import { expect } from 'chai'
import { describe, it } from 'mocha'

import { floatingNavBottom, navContentBottom } from './navClearance'

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
    expect(withBanner - gap).equals(53)
    expect(height + withBanner).equals(hostHeight + 53)
    expect(floatingNavBottom('ios', margin, 0)).equals(0)
  })

  it('keeps Android a margin above its navigation inset', function () {
    expect(floatingNavBottom('android', margin, inset)).equals(margin + inset)
  })

  it('keeps the browser on the designed margin, with no inset to add', function () {
    expect(floatingNavBottom('web', margin, 0)).equals(margin)
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
})
