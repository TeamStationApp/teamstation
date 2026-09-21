import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  MAX_VIDEO_WIDTH,
  MIN_SHORT_VIDEO,
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

  it('splits at the width an iPhone on its side actually has', function () {
    // The case that has now been got wrong twice, so it is pinned at the
    // numbers a device reports rather than at round ones.
    //
    // An iPhone 17 Pro in landscape is 874 points across and spends about 126
    // of them on the camera housing and the rounded corner, so the layout is
    // asked for 748. The first version of this code was handed 874 — the
    // whole screen — and produced two columns that did not fit, and the
    // highlight list ended up underneath the picture. Handing it 748 fixed
    // that and broke the other side: `short` stopped firing, and the picture
    // sat in a 722-wide stack with 112 points of dead page either side.
    //
    // Both are the same mistake, which is deciding on a width the content
    // does not have. This asserts the arrangement at the width it does.
    const phone = {
      width: 748,
      height: 402,
      chromeHeight: 60,
      belowVideo: 62,
      aspect: 16 / 9,
      previous: 'stacked' as WatchMode
    }
    const laid = watchLayout(phone)

    expect(laid.short).equals(true)
    expect(laid.mode).equals('sideBySide')
    // A real column, not a token one.
    expect(laid.sideWidth).is.at.least(SIDE_MIN_SHORT)
    // And a picture still worth watching, having given the column its due.
    expect(laid.videoWidth).is.at.least(MIN_SHORT_VIDEO)
    // The two of them inside the row they share, which is the whole point.
    expect(laid.videoWidth + laid.sideWidth).is.at.most(phone.width - 72)
  })

  it('keeps the score card on every window a laptop has', function () {
    // The regression this is here to stop, which shipped for one commit and
    // was found on the web rather than on a phone: `short` hides the card —
    // `GameWatchLayout` draws nothing where the card goes when it is true —
    // and a predicate that asked `heightBound < stackedWidth` was true of
    // *every* 16:9 and 16:10 window, because that is the definition of one.
    // The card vanished at 1366x768 and 1920x1080 and came back at 1920x1200,
    // with the two columns otherwise identical either side of the flip.
    const laptops = [
      [1280, 800],
      [1366, 768],
      [1440, 900],
      [1512, 982],
      [1680, 1050],
      [1920, 1080],
      [1920, 1200],
      [2560, 1440]
    ]
    // **At a realistic header height.** The first version of this test used
    // `base`, whose `chromeHeight` is 48, and passed while the real thing
    // failed: the app's header measures about 72, and those 24 points were
    // the entire margin. A test that cannot fail on the configuration that
    // ships is not a test.
    for (const [width, height] of laptops) {
      for (const chromeHeight of [48, 72, 96]) {
        const laid = watchLayout({ ...base, width, height, chromeHeight })
        const where = `${width}x${height} chrome ${chromeHeight}`
        expect(laid.short, where).equals(false)
        // And a desktop list never gets the floor meant for a phone.
        expect(laid.sideWidth, where).is.at.least(SIDE_MIN)
      }
    }
  })

  it('stacks when the column would leave no picture worth having', function () {
    // The other side of that judgement: narrow enough that taking 260 points
    // for a list would leave a picture nobody wants, so it stays stacked.
    const narrow = watchLayout({
      ...base,
      width: 600,
      height: 200
    })
    expect(narrow.short).equals(false)
    expect(narrow.mode).equals('stacked')
  })

  it('never asks for more width than it was given, wherever it splits', function () {
    // The wrap was silent, so this is the invariant worth holding: whatever
    // the window, the picture and the column together fit the row they share.
    // A phone on its side is the interesting end, so walk across it.
    for (let width = 600; width <= 1400; width += 7) {
      for (const height of [350, 411, 430, 900]) {
        const laid = watchLayout({ ...landscapePhone, width, height })
        if (laid.mode !== 'sideBySide') continue
        expect(
          laid.videoWidth + laid.sideWidth,
          `${width}x${height}`
        ).is.at.most(width)
      }
    }
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
    // 600x200 rather than 900x400, because a 900-wide window now splits: it
    // has room for a list beside the picture and takes it. The cap being
    // tested here is the *stacked* one, so the window has to be one that
    // stays stacked — narrow enough that a 260-point column would leave no
    // picture worth having.
    const squat = watchLayout({ ...base, width: 600, height: 200 })
    expect(squat.mode).equals('stacked')
    expect(squat.videoHeight).equals(200 - 48)
    expect(squat.videoWidth / squat.videoHeight).closeTo(16 / 9, 0.02)
    expect(squat.videoWidth).is.below(600)
  })
})
