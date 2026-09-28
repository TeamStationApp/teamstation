import { expect } from 'chai'
import { describe, it } from 'mocha'

import { isLaunchAngle } from './launchAngle'

describe('launch angles', function () {
  it('are finite degrees from -90 to 90', function () {
    for (const degrees of [-90, -12.5, 0, 45, 90])
      expect(isLaunchAngle(degrees), String(degrees)).equals(true)
    for (const value of [-90.5, 91, Number.NaN, Infinity, '45', null])
      expect(isLaunchAngle(value), String(value)).equals(false)
  })
})
