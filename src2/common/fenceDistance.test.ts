import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asFenceDistanceBody,
  DEFAULT_FENCE_DISTANCE_FT,
  isFenceDistance,
  MAX_FENCE_DISTANCE_FT
} from './fenceDistance'

describe('fence distances', function () {
  it('plays to 200 feet unless told otherwise, and to no more than 600', function () {
    expect(DEFAULT_FENCE_DISTANCE_FT).equals(200)
    expect(MAX_FENCE_DISTANCE_FT).equals(600)
    for (const feet of [1, 200, 600]) expect(isFenceDistance(feet)).equals(true)
    for (const feet of [0, -1, 601, 200.5, Number.NaN, '200', null])
      expect(isFenceDistance(feet), String(feet)).equals(false)
  })

  it('takes whole feet or null, and names what else is wrong', function () {
    expect(asFenceDistanceBody({ fenceDistanceFt: 225 })).deep.equals({
      fenceDistanceFt: 225
    })
    expect(asFenceDistanceBody({ fenceDistanceFt: null })).deep.equals({
      fenceDistanceFt: null
    })
    for (const raw of [null, [], 'far', {}, { fenceDistanceFt: 0 }]) {
      expect(() => asFenceDistanceBody(raw), JSON.stringify(raw)).throws(
        TypeError,
        /fenceDistanceFt/
      )
    }
  })
})
