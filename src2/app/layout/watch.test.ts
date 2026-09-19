import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  MAX_VIDEO_WIDTH,
  PHONE_MARGIN,
  SIDE_MIN,
  SIDE_MIN_SHORT,
  SIDE_WIDTH,
  watchLayout,
  type WatchMode
} from './watch'

const base = {
  height: 900,
  chromeHeight: 48,
  aspect: 16 / 9,
  previous: 'stacked' as WatchMode
}

describe('watch layout', function () {
  it('stacks below a thousand and splits at it', function () {
    expect(watchLayout({ ...base, width: 999 }).mode).equals('stacked')
    expect(watchLayout({ ...base, width: 1000 }).mode).equals('sideBySide')
  })

  it('holds the mode through the gap, from either direction', function () {
    // Dragging a window across the boundary must not flap between layouts.
    expect(
      watchLayout({ ...base, width: 980, previous: 'sideBySide' }).mode
    ).equals('sideBySide')
    expect(
      watchLayout({ ...base, width: 980, previous: 'stacked' }).mode
    ).equals('stacked')
    expect(
      watchLayout({ ...base, width: 959, previous: 'sideBySide' }).mode
    ).equals('stacked')
  })

  it('gives the highlights YouTube s column on a wide window', function () {
    const wide = watchLayout({ ...base, width: 1440, previous: 'sideBySide' })
    expect(wide.sideWidth).equals(SIDE_WIDTH)
    // 1440 - 48 of margin - 402 - 24 of gutter
    expect(wide.videoWidth).equals(966)
  })

  it('narrows that column rather than the video at the low end', function () {
    const tight = watchLayout({ ...base, width: 1000, previous: 'sideBySide' })
    expect(tight.sideWidth).is.at.least(SIDE_MIN)
    expect(tight.sideWidth).is.below(SIDE_WIDTH)
    expect(tight.videoWidth).is.at.least(600)
  })

  it('stops growing the picture where YouTube does', function () {
    const huge = watchLayout({
      ...base,
      width: 3000,
      height: 2000,
      previous: 'sideBySide'
    })
    expect(huge.videoWidth).equals(MAX_VIDEO_WIDTH)
  })

  it('gives a stacked picture the same margin as the card, less a pixel', function () {
    // A hair wider than the card and the rows, so it covers them as they pass
    // underneath it — but a margin, not an edge-to-edge bleed.
    const stacked = watchLayout({ ...base, width: 390 })
    expect(stacked.videoWidth).equals(390 - 2 * PHONE_MARGIN)
  })

  it('keeps a recording s own shape, whatever it is', function () {
    // Two cameras side by side are 32:9, and a box that assumed 16:9 would
    // paint the difference black.
    const wideFilm = watchLayout({ ...base, width: 800, aspect: 32 / 9 })
    expect(wideFilm.videoWidth / wideFilm.videoHeight).closeTo(32 / 9, 0.02)
    const tallFilm = watchLayout({ ...base, width: 800, aspect: 4 / 3 })
    expect(tallFilm.videoWidth / tallFilm.videoHeight).closeTo(4 / 3, 0.02)
  })

  // A phone held sideways: about 930 by 350 once Safari has taken its share.
  const landscapePhone = {
    width: 932,
    height: 350,
    chromeHeight: 48,
    belowVideo: 52,
    aspect: 16 / 9,
    previous: 'stacked' as WatchMode
  }

  it('splits a phone held sideways, though it is nowhere near a thousand', function () {
    const laid = watchLayout(landscapePhone)
    expect(laid.short).equals(true)
    expect(laid.mode).equals('sideBySide')
  })

  it('leaves the buttons under a sideways picture on the screen', function () {
    const laid = watchLayout(landscapePhone)
    // The picture and the row of camera angles, inside the window.
    expect(laid.videoHeight + landscapePhone.belowVideo).is.at.most(
      landscapePhone.height - landscapePhone.chromeHeight
    )
    // And it took all the height it could, rather than some of it.
    expect(laid.videoHeight).equals(
      landscapePhone.height - landscapePhone.chromeHeight - 52
    )
  })

  it('hands the width the sideways picture cannot use to the list', function () {
    const laid = watchLayout(landscapePhone)
    expect(laid.sideWidth).equals(SIDE_WIDTH)
    expect(laid.videoWidth + laid.sideWidth).is.at.most(landscapePhone.width)
  })

  it('lets that column go narrower than a desktop s on a small phone', function () {
    // A 667pt phone on its side has not got 300 to give the list and a
    // picture as well.
    const small = watchLayout({ ...landscapePhone, width: 667, height: 285 })
    expect(small.mode).equals('sideBySide')
    expect(small.sideWidth).is.at.least(SIDE_MIN_SHORT)
    expect(small.sideWidth).is.below(SIDE_MIN)
    expect(small.videoWidth + small.sideWidth).is.at.most(667)
  })

  it('stacks a phone held upright, where the width is what binds', function () {
    const upright = watchLayout({ ...landscapePhone, width: 390, height: 844 })
    expect(upright.short).equals(false)
    expect(upright.mode).equals('stacked')
  })

  it('leaves a desktop where it was', function () {
    const desk = watchLayout({
      ...landscapePhone,
      width: 1440,
      height: 900,
      previous: 'sideBySide'
    })
    expect(desk.short).equals(false)
    expect(desk.sideWidth).equals(SIDE_WIDTH)
    expect(desk.videoWidth).equals(966)
  })

  it('caps the height to the room under the header, and keeps the ratio', function () {
    const short = watchLayout({ ...base, width: 900, height: 400 })
    expect(short.videoHeight).equals(400 - 48)
    expect(short.videoWidth / short.videoHeight).closeTo(16 / 9, 0.02)
    expect(short.videoWidth).is.below(900)
  })
})
