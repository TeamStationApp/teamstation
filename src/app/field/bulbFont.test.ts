import { expect } from 'chai'
import { describe, it } from 'mocha'

import { bulbGlyph } from './bulbFont'

describe('the bulb font', function () {
  const blank = bulbGlyph('~')

  it('draws a jersey number sign', function () {
    const sign = bulbGlyph('#')
    expect(sign).not.deep.equals(blank)
    expect(sign).length(7)
    for (const row of sign) expect(row).match(/^[01]{5}$/)
  })

  it('leaves a character it does not know blank', function () {
    expect(blank).deep.equals(Array.from({ length: 7 }, () => '00000'))
  })
})
