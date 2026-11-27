import { expect } from 'chai'

import {
  NAV_BOTTOM_GAP,
  NAV_COMPACT_HEIGHT,
  NAV_COMPACT_WIDTH,
  NAV_HEIGHT,
  NAV_NATIVE_HEIGHT_ABOVE_INSET,
  NAV_PILL_PAD,
  NAV_SIDE_INSET
} from './navGeometry'

describe('the tab bar at the measured iPhone width', () => {
  it('uses the iOS platter bounds within the full-width UIKit host', () => {
    expect(NAV_NATIVE_HEIGHT_ABOVE_INSET + 34).equals(83)
    expect(393 - 2 * NAV_SIDE_INSET).equals(351)
    expect(NAV_HEIGHT + NAV_BOTTOM_GAP).equals(83)
    expect(NAV_HEIGHT - 2 * NAV_PILL_PAD).equals(54)
    expect(NAV_COMPACT_HEIGHT).equals(52)
    expect(NAV_COMPACT_WIDTH / 5).at.least(44)
  })
})
