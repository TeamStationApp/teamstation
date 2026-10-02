import { expect } from 'chai'
import { readFileSync } from 'fs'
import { describe, it } from 'mocha'
import { join } from 'path'

describe('Reanimated on the phones', function () {
  it('never hands settled animation values back to React', function () {
    // With it on, Reanimated sets the state of every animated view whose
    // values settled, twice a second (the nameplates each time the field
    // stops moving), and re-renders them with values that may since have
    // moved on. On a long Undo run those updates were one of the sources
    // that kept React's nested-update count climbing until it threw
    // "Maximum update depth exceeded" from Reanimated's timer. The native
    // builds read the flag from here.
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../../package.json'), 'utf8')
    ) as {
      reanimated?: { staticFeatureFlags?: Record<string, boolean> }
    }
    expect(
      pkg.reanimated?.staticFeatureFlags
        ?.FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS
    ).equals(false)
  })
})
