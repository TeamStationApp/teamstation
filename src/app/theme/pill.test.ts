import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  COMPACT_PILL_LABEL_REM,
  COMPACT_PILL_REM,
  compactPill,
  pillPadding,
  pillShadow
} from './pill'
import { tsBallpark } from './tsBallpark'

const theme = tsBallpark

describe('the shared pill', function () {
  it('draws a compact pill 20 points tall with semicircular ends and a 12-point label', function () {
    expect(COMPACT_PILL_REM).equals(1.25)
    expect(COMPACT_PILL_LABEL_REM).equals(0.75)
    expect(compactPill(theme)).deep.equals({
      height: 20,
      minHeight: 20,
      borderRadius: 10,
      paddingHorizontal: pillPadding(20)
    })
  })

  it('lifts a pill on the raised button’s shadow', function () {
    expect(pillShadow(theme)).deep.equals({
      shadowColor: tsBallpark.buttonShadowColor,
      shadowOpacity: 1,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 3
    })
  })
})
