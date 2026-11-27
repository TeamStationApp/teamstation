import { expect } from 'chai'

import {
  capsuleLabels,
  dragOutcome,
  highlightWidth,
  labelRoom,
  pillFrame,
  pillOffset,
  slotAt,
  tabContentOffset
} from './tabBarModel'

describe('tab bar drag geometry', () => {
  for (const height of [52, 62]) {
    it(
      'allows one current slot height around a ' + height + ' point capsule',
      () => {
        const row = { width: 350, height, count: 5 }
        for (const y of [-height, -height / 2, 0, height, 2 * height])
          expect(dragOutcome(245, y, row)).equals(3)
        for (const y of [-height - 0.1, 2 * height + 0.1])
          expect(dragOutcome(245, y, row)).equals(null)
        expect(dragOutcome(-height, 26, row)).equals(0)
        expect(dragOutcome(350 + height, 26, row)).equals(4)
        expect(dragOutcome(-height - 1, 26, row)).equals(null)
        expect(dragOutcome(351 + height, 26, row)).equals(null)
      }
    )
  }
  it('tracks the physical slot under the finger in RTL and moves from the right edge', () => {
    const rtl = { count: 5, width: 350, height: 62, rtl: true }
    for (let index = 0; index < rtl.count; index++) {
      const x = rtl.width - (index + 0.5) * 70
      expect(slotAt(x, rtl.width, rtl.count, true)).equals(index)
      expect(dragOutcome(x, -rtl.height, rtl)).equals(index)
      // A highlight as wide as its slot less the padding steps one slot.
      expect(pillOffset(index, rtl.width, 62, rtl.count, 4, true)).equals(
        -(index * 70 + 4)
      )
    }
    expect(dragOutcome(0, 30, rtl)).equals(4)
    expect(dragOutcome(350, 30, rtl)).equals(0)
  })
  it('keeps the rightmost and leftmost selection inside every intermediate shell frame', () => {
    for (const width of [228, 249.5, 301.25, 351]) {
      for (const rtl of [true, false]) {
        // The highlight's own width eases separately during a resize.
        for (const highlight of [highlightWidth(width, 5, 4), 60, 86.4])
          for (const index of [-0.1, 0, 2.6, 4, 4.2]) {
            const pill = pillFrame(index, width, highlight, 5, 4, rtl)
            const left = rtl ? width + pill.x - pill.width : pill.x
            expect(left).to.be.at.least(4 - 1e-6)
            expect(left + pill.width).to.be.at.most(width - 4 + 1e-6)
            expect(pill.width).equals(Math.min(highlight, width - 8))
          }
      }
    }
  })
  it('keeps default-size labels inside the pill across common phone widths', () => {
    for (const width of [360, 375, 390, 393, 412, 430]) {
      const slot = (width - 42) / 5
      const label = capsuleLabels(width - 42, 54, 1)
      expect(label, width + ' points').deep.equals({
        points: 10,
        lineHeight: 13,
        separate: false
      })
      expect(48, width + ' points').to.be.at.most(slot - 8)
    }
    expect(capsuleLabels(351, 54, 1.24).separate).equals(false)
  })
  it('gives accessibility-sized or too-wide labels their own line', () => {
    for (const [width, scale] of [
      [320, 1],
      [280, 1],
      [393, 1.5],
      [430, 1.4],
      [320, 2],
      [393, 1.35]
    ]) {
      const slot = (width - 42) / 5
      const label = capsuleLabels(width - 42, 54, scale)
      expect(label.separate, width + ' at ' + scale).equals(true)
      expect(4.8 * label.points).to.be.at.most(slot - 4 + 1e-6)
    }
  })
  it('uses exact slot boundaries and preserves end slots', () => {
    expect(slotAt(70, 350, 5)).equals(1)
    expect(slotAt(350, 350, 5)).equals(4)
    expect(slotAt(0, 1, 1)).equals(0)
    expect(slotAt(30, 0, 5)).equals(-1)
    expect(pillOffset(3, 350, 62, 5, 4)).equals(214)
  })
})

// UIKit's tab buttons on iOS 27.2, from TabBarViewTests: the mean width of
// the five under each platter (Schedule's is a few points wider than the rest
// below 402 points), and the compact platter's.
const uikitHighlight = [
  [360, 78],
  [390, 84],
  [393, 84.6],
  [412, 80],
  [430, 82.6]
] as const

describe('the selected highlight mirrors UIKit', () => {
  it('is as wide as the UIKit highlight at the same screen width', () => {
    for (const [screen, width] of uikitHighlight) {
      const shell = screen - 42
      expect(highlightWidth(shell, 5, 4), screen + ' points').closeTo(
        width,
        1e-9
      )
      // Wider than its fifth of the bar: it reaches past the halfway point
      // to each neighbour, and still starts and ends inside the platter.
      expect(highlightWidth(shell, 5, 4)).above(shell / 5)
      const last = pillFrame(4, shell, width, 5, 4, false)
      expect(pillFrame(0, shell, width, 5, 4, false).x).equals(4)
      expect(last.x + last.width).closeTo(shell - 4, 1e-9)
    }
    // The compact platter, 228 by 52, has 60-point highlights 40 apart.
    expect(highlightWidth(228, 5, 4)).equals(60)
    expect(pillOffset(1, 228, 60, 5, 4)).equals(44)
    expect(highlightWidth(0, 5, 4)).equals(0)
    expect(highlightWidth(100, 1, 4)).equals(92)
  })
  it('centres each tab on its highlight and mirrors that in RTL', () => {
    const shell = 351
    const width = highlightWidth(shell, 5, 4)
    for (let index = 0; index < 5; index++) {
      const pill = pillFrame(index, shell, width, 5, 4, false)
      const centre = ((index + 0.5) * shell) / 5
      const offset = tabContentOffset(index, shell, width, 5, 4)
      expect(centre + offset).closeTo(pill.x + pill.width / 2, 1e-9)
      expect(tabContentOffset(index, shell, width, 5, 4, true)).equals(-offset)
      expect(tabContentOffset(index, shell, shell / 5 - 8, 5, 4)).closeTo(
        0,
        1e-9
      )
    }
    expect(tabContentOffset(2, shell, width, 5, 4)).closeTo(0, 1e-9)
    expect(tabContentOffset(0, shell, width, 5, 4)).closeTo(11.2, 1e-9)
  })
  it('keeps a default-size label clear of the rounded ends and its neighbours', () => {
    for (const screen of [360, 375, 390, 393, 412, 430]) {
      const shell = screen - 42
      const width = highlightWidth(shell, 5, 4)
      const step = (shell - 8 - width) / 4
      expect(labelRoom(width, 54), screen + ' points').at.least(48)
      expect(step - 4, screen + ' points').at.least(48)
    }
    // The bottom of a label 7 points above a 54-point capsule's bottom edge
    // loses 27 - sqrt(27^2 - 20^2) to each rounded end.
    expect(labelRoom(100, 54)).closeTo(100 - 2 * (27 - Math.sqrt(329)), 1e-9)
    expect(labelRoom(10, 54)).equals(0)
  })
})
