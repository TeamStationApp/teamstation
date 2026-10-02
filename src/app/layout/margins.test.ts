import { expect } from 'chai'
import { describe, it } from 'mocha'

import { tsDark } from '../theme/tsDark'
import { edgeMarginRem } from './margins'

describe('margins', function () {
  it('widens a step above a phone', function () {
    expect(edgeMarginRem(tsDark, 'phone')).is.lessThan(
      edgeMarginRem(tsDark, 'tablet')
    )
  })

  it('gives a tablet and a desktop the same margin', function () {
    expect(edgeMarginRem(tsDark, 'tablet')).equals(
      edgeMarginRem(tsDark, 'desktop')
    )
  })

  it('is wide enough to read as a margin rather than a mistake', function () {
    // The header used to carry `spaceSm` while the cards carried this, which
    // is what made the mark sit half as far in as the card below it.
    expect(edgeMarginRem(tsDark, 'phone')).is.greaterThan(tsDark.spaceSmRem)
  })
})
