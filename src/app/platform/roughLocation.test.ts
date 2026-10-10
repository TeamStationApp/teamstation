import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type LocationProvider, requestRoughLocation } from './roughLocation'

describe('one-shot rough location', () => {
  it('returns valid coordinates and maps permission/provider errors', async () => {
    expect(
      await requestRoughLocation(success => {
        success({ coords: { latitude: 1, longitude: 2 } })
      })
    ).deep.equals({ status: 'success', latitude: 1, longitude: 2 })
    for (const [code, status] of [
      [1, 'denied'],
      [2, 'unavailable'],
      [3, 'timeout']
    ] as const)
      expect(
        await requestRoughLocation((_success, failure) => {
          failure({ code })
        })
      ).deep.equals({ status })
    expect(
      await requestRoughLocation(() => {
        throw new Error('unavailable')
      })
    ).deep.equals({ status: 'unavailable' })
    expect(
      await requestRoughLocation(success => {
        success({ coords: { latitude: NaN, longitude: 2 } })
      })
    ).deep.equals({ status: 'unavailable' })
  })
  it('resolves deadline once and ignores a later provider result', async () => {
    let success: Parameters<LocationProvider>[0] = () => {}
    const result = await requestRoughLocation(callback => {
      success = callback
    }, 2)
    expect(result).deep.equals({ status: 'timeout' })
    success({ coords: { latitude: 1, longitude: 2 } })
    expect(result).deep.equals({ status: 'timeout' })
  })
})
