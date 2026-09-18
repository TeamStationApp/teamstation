import { expect } from 'chai'
import { describe, it } from 'mocha'

import { gsDark } from '../theme/gsDark'
import { edgeMarginRem } from './margins'

describe('margins', function () {
  it('widens a step above a phone', function () {
    expect(edgeMarginRem(gsDark, 'phone')).is.lessThan(
      edgeMarginRem(gsDark, 'tablet')
    )
  })

  it('gives a tablet and a desktop the same margin', function () {
    expect(edgeMarginRem(gsDark, 'tablet')).equals(
      edgeMarginRem(gsDark, 'desktop')
    )
  })

  it('is wide enough to read as a margin rather than a mistake', function () {
    // The header used to carry `spaceSm` while the cards carried this, which
    // is what made the mark sit half as far in as the card below it.
    expect(edgeMarginRem(gsDark, 'phone')).is.greaterThan(gsDark.spaceSmRem)
  })
})
