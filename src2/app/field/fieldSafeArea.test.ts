import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  FIELD_EDGE_GAP,
  fieldSafePadding,
  menuButtonEdges,
  scoringMenuFrame,
  toastTopBelow,
  WEB_MENU_BUTTON
} from './fieldSafeArea'

describe('field safe area', function () {
  it('keeps the bottom deck the web gap above the home indicator', function () {
    // iPhone 13 Pro and 17 Pro, portrait: 34 points for the home indicator.
    expect(
      fieldSafePadding({ top: 47, bottom: 34, left: 0, right: 0 })
    ).deep.equals({
      paddingTop: 47,
      paddingBottom: 34 + FIELD_EDGE_GAP,
      paddingLeft: FIELD_EDGE_GAP,
      paddingRight: FIELD_EDGE_GAP
    })
    // Held sideways: the notch at one side, a 21 point indicator below.
    expect(
      fieldSafePadding({ top: 0, bottom: 21, left: 47, right: 47 })
    ).deep.equals({
      paddingTop: FIELD_EDGE_GAP,
      paddingBottom: 29,
      paddingLeft: 47,
      paddingRight: 47
    })
    // No inset at all is the web's 8 points on every side.
    expect(
      fieldSafePadding({ top: 0, bottom: 0, left: 0, right: 0 })
    ).deep.include({ paddingBottom: FIELD_EDGE_GAP })
  })

  it('opens the menu and the toast below ☰, wherever the inset puts it', function () {
    // The web: ☰ 48 square at 8, 8, menu at 64 from the top and 12 from the
    // right, and the toast no higher than 62.
    expect(scoringMenuFrame(WEB_MENU_BUTTON)).deep.equals({
      top: 64,
      right: 12
    })
    expect(toastTopBelow(WEB_MENU_BUTTON)).equals(62)
    expect(
      menuButtonEdges({ x: 8, y: 8, width: 374, height: 48 }, 390)
    ).deep.equals(WEB_MENU_BUTTON)
    // iPhone 13 Pro, portrait: ☰ at the 47 point inset, 47–95.
    const phone = menuButtonEdges({ x: 8, y: 47, width: 374, height: 48 }, 390)
    expect(phone).deep.equals({ bottom: 95, right: 8 })
    expect(scoringMenuFrame(phone)).deep.equals({ top: 103, right: 12 })
    expect(toastTopBelow(phone)).equals(101)
    // Held sideways: ☰ 8 from the top, beside the notch's 47 point inset.
    const sideways = menuButtonEdges(
      { x: 47, y: 8, width: 750, height: 48 },
      844
    )
    expect(scoringMenuFrame(sideways)).deep.equals({ top: 64, right: 51 })
  })
})
