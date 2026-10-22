import { expect } from 'chai'
import { describe, it } from 'mocha'

import { FIELD_EDGE_GAP } from '../field/fieldSafeArea'
import {
  CONTROL_DECK_HEIGHT,
  CONTROL_GAP,
  CONTROL_HEIGHT
} from './scoringControlStyle'
import { scoringStatusFrame } from './scoringStatusPlacement'

/** An iPhone 15 Pro held upright: the island and the home indicator. */
const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 }

describe('the scoring status line placement', function () {
  it('sits on a phone above the deck and the band of controls on it, never at the top', function () {
    const frame = scoringStatusFrame(true, IPHONE)
    expect(frame).not.have.property('top')
    // The deck's top edge, as the field's safe padding leaves it.
    const deckTop = IPHONE.bottom + FIELD_EDGE_GAP + CONTROL_DECK_HEIGHT
    expect(frame.bottom).equals(
      deckTop + CONTROL_GAP + CONTROL_HEIGHT + CONTROL_GAP
    )
    expect(frame.bottom).equals(234)
    expect(frame).deep.include({
      position: 'absolute',
      left: FIELD_EDGE_GAP,
      right: FIELD_EDGE_GAP,
      alignItems: 'center'
    })
    // A phone on its side keeps clear of the notch on either edge.
    expect(
      scoringStatusFrame(true, { top: 0, bottom: 21, left: 59, right: 47 })
    ).deep.include({ left: 59, right: 47, bottom: 21 + 200 })
  })

  it('stays centred 8 from the top on the web, as it always was', function () {
    expect(scoringStatusFrame(false, IPHONE)).deep.equals({
      position: 'absolute',
      top: FIELD_EDGE_GAP,
      left: 0,
      right: 0,
      alignItems: 'center'
    })
  })
})
