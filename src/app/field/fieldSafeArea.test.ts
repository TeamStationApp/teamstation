import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  bandedSafe,
  FIELD_EDGE_GAP,
  fieldSafePadding,
  FLOATING_MARGIN,
  FLOATING_SIZE,
  floatingBottom,
  liftedSafePadding,
  menuButtonEdges,
  scoringMenuFrame,
  toastTopBelow,
  TOP_LIFT,
  topLift,
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

  it('lifts the top controls and the scene half a button, never above the edge gap', function () {
    expect(TOP_LIFT).equals(24)
    // A browser, or a phone with no top inset: already at the 8 point gap.
    for (const os of ['ios', 'web']) {
      expect(topLift(0, os)).equals(0)
      expect(topLift(FIELD_EDGE_GAP, os)).equals(0)
      expect(topLift(20, os)).equals(12)
    }
    // An iPhone's island: the whole half button.
    expect(topLift(59, 'ios')).equals(24)
    // A browser lifts by its inset, as an iPhone does.
    expect(topLift(59, 'web')).equals(24)
  })

  it('pads the lifted top controls by one rule, as numbers or as the web’s env()', function () {
    // An iPhone's island: 59 less the 24 point lift, the sides as the
    // field's padding has them.
    expect(
      liftedSafePadding({ top: 59, bottom: 34, left: 0, right: 0 }, 24)
    ).deep.equals({
      paddingTop: 35,
      paddingBottom: 34 + FIELD_EDGE_GAP,
      paddingLeft: FIELD_EDGE_GAP,
      paddingRight: FIELD_EDGE_GAP
    })
    // Held sideways: no top inset, no lift, the notch's side kept.
    expect(
      liftedSafePadding({ top: 0, bottom: 21, left: 47, right: 47 }, 0)
    ).deep.include({ paddingTop: FIELD_EDGE_GAP, paddingLeft: 47 })
    // With the lift topLift gives, never above the edge gap, and the same
    // number the scoring screen's header row gets from bandedSafe.
    for (const inset of [0, 8, 12, 20, 32, 59]) {
      const insets = { top: inset, bottom: 0, left: 0, right: 0 }
      const lift = topLift(inset, 'ios')
      const top = liftedSafePadding(insets, lift).paddingTop
      expect(top, `inset ${inset}`).equals(
        Math.max(FIELD_EDGE_GAP, inset - lift)
      )
      expect(top, `inset ${inset}`).equals(
        bandedSafe(fieldSafePadding(insets), -lift).paddingTop
      )
    }
    // The web's header row: the same lift through calc().
    expect(
      bandedSafe({ paddingTop: 'max(8px, env(safe-area-inset-top))' }, -24)
        .paddingTop
    ).equals('calc(max(8px, env(safe-area-inset-top)) - 24px)')
  })

  it('never lifts on Android, whose status bar icons the buttons would cover', function () {
    for (const inset of [0, 24, 50.29, 59])
      expect(topLift(inset, 'android'), `inset ${inset}`).equals(0)
  })

  it('centres the floating buttons on the bottom safe edge, kept on the screen', function () {
    expect(FLOATING_SIZE).equals(56)
    expect(floatingBottom(0)).equals(FLOATING_MARGIN)
    expect(floatingBottom(0)).equals(16)
    // A gesture bar's small inset keeps the button 4 points off the edge.
    expect(floatingBottom(24)).equals(4)
    expect(floatingBottom(34)).equals(6)
    expect(floatingBottom(48)).equals(20)
  })
})
