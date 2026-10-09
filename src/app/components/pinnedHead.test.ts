import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  anchored,
  AT_REST,
  cardOffset,
  inStep,
  pillsOffset,
  scrolled,
  spacerFor
} from './pinnedHead'

/** How far the page scrolls before the pills meet the header. */
const PIN_AT = 120

describe('the pinned head', function () {
  describe('scrolling', function () {
    it('keeps the head in step on a plain scroll from the top', function () {
      let head = AT_REST
      for (const y of [40, 90, 200, 600]) {
        head = scrolled(head, y)
        expect(head).deep.equals({ y, collapse: y })
        expect(inStep(head)).equals(true)
      }
    })

    it('brings the card back only as the page returns to it', function () {
      const down = scrolled(scrolled(AT_REST, 400), 100)
      expect(down).deep.equals({ y: 100, collapse: 100 })
    })

    it('holds the head out of step until the page drops below it', function () {
      // Anchored: the content jumped 500 and the head did not move.
      const held = { y: 500, collapse: 0 }
      expect(inStep(held)).equals(false)
      // Down shows what is above, and the head stays put.
      expect(scrolled(held, 200)).deep.equals({ y: 200, collapse: 0 })
      // Up takes the head with it, exactly as far as the content moved.
      expect(scrolled(held, 560)).deep.equals({ y: 560, collapse: 60 })
    })

    it('follows the page back to the top once it is below the head', function () {
      const pinnedHigh = { y: 900, collapse: 300 }
      expect(scrolled(pinnedHigh, 250)).deep.equals({ y: 250, collapse: 250 })
      expect(scrolled(pinnedHigh, 0)).deep.equals({ y: 0, collapse: 0 })
    })

    it('treats a bounce above the top as the top', function () {
      expect(scrolled(AT_REST, -40)).deep.equals({ y: -40, collapse: 0 })
      expect(scrolled({ y: -40, collapse: 0 }, 0)).deep.equals({
        y: 0,
        collapse: 0
      })
    })
  })

  describe('offsets', function () {
    it('draws everything where the page puts it at rest', function () {
      expect(cardOffset(AT_REST)).equals(0)
      expect(pillsOffset(AT_REST, PIN_AT)).equals(0)
    })

    it('leaves the card in the flow in step, and pins the pills past pinAt', function () {
      const below = { y: 80, collapse: 80 }
      expect(cardOffset(below)).equals(0)
      expect(pillsOffset(below, PIN_AT)).equals(0)
      const past = { y: 700, collapse: 700 }
      expect(cardOffset(past)).equals(0)
      expect(pillsOffset(past, PIN_AT)).equals(700 - PIN_AT)
    })

    it('holds both still out of step', function () {
      const held = { y: 500, collapse: 30 }
      expect(cardOffset(held)).equals(470)
      expect(pillsOffset(held, PIN_AT)).equals(470)
      // Pinned and held: the pills stay at the header, the card above it.
      const pinnedHeld = { y: 900, collapse: 200 }
      expect(pillsOffset(pinnedHeld, PIN_AT)).equals(900 - PIN_AT)
      expect(cardOffset(pinnedHeld)).equals(700)
    })

    it('never draws the card above where the page puts it', function () {
      expect(cardOffset({ y: -40, collapse: 0 })).equals(0)
    })
  })

  describe('anchoring a tab', function () {
    it('from rest, scrolls only the content, the card held where it was', function () {
      expect(anchored(AT_REST, 640, PIN_AT)).deep.equals({
        y: 640,
        collapse: 0
      })
      expect(anchored(AT_REST, 0, PIN_AT)).deep.equals(AT_REST)
    })

    it('keeps a part-collapsed card exactly where it is', function () {
      const part = { y: 60, collapse: 60 }
      const next = anchored(part, 640, PIN_AT)
      expect(next).deep.equals({ y: 700, collapse: 60 })
      // The card's top on screen is columnTop - collapse: unchanged.
      expect(next.collapse).equals(part.collapse)
    })

    it('keeps pinned pills pinned', function () {
      const pinned = { y: PIN_AT, collapse: PIN_AT }
      expect(anchored(pinned, 640, PIN_AT)).deep.equals({
        y: 640 + PIN_AT,
        collapse: PIN_AT
      })
      expect(anchored(pinned, 0, PIN_AT)).deep.equals(pinned)
    })

    it('never brings a card that has gone under the header back out', function () {
      const gone = { y: 2000, collapse: 2000 }
      const toTop = anchored(gone, 0, PIN_AT)
      expect(toTop).deep.equals({ y: PIN_AT, collapse: PIN_AT })
      const toRow = anchored(gone, 640, PIN_AT)
      expect(toRow).deep.equals({ y: 640 + PIN_AT, collapse: 640 + PIN_AT })
      for (const head of [toTop, toRow]) {
        expect(head.collapse).to.be.at.least(PIN_AT)
        expect(pillsOffset(head, PIN_AT)).equals(head.y - PIN_AT)
      }
    })

    it('lets the page be dragged up from the anchor until the pills pin', function () {
      // From the anchor the page has `rowOffset + pinAt` to travel; once it
      // has, the pills are pinned and the anchored row is right under them.
      const anchor = anchored(AT_REST, 640, PIN_AT)
      const pinned = scrolled(anchor, 640 + PIN_AT)
      expect(pinned).deep.equals({ y: 640 + PIN_AT, collapse: PIN_AT })
      expect(pillsOffset(pinned, PIN_AT)).equals(640)
    })
  })

  describe('room after the content', function () {
    it('is nothing when the content is long enough', function () {
      expect(spacerFor(760, 3000, 844)).equals(0)
      expect(spacerFor(760, 760 + 844, 844)).equals(0)
    })

    it('is exactly the shortfall otherwise', function () {
      expect(spacerFor(760, 1200, 844)).equals(760 + 844 - 1200)
      expect(spacerFor(PIN_AT, 300, 844)).equals(PIN_AT + 844 - 300)
    })
  })
})
