import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type NativeLocationBridge,
  requestNativeRoughLocation
} from './roughLocationNative'

describe('native rough-location decision boundary', () => {
  it('requests coarse permission on Android and when-in-use reduced location on iOS', async () => {
    const configs: unknown[] = []
    const bridge: NativeLocationBridge = {
      setRNConfiguration: options => {
        configs.push(options)
      },
      getCurrentPosition: success => {
        success({ coords: { latitude: 1, longitude: 2 } })
      }
    }
    let requests = 0
    expect(
      await requestNativeRoughLocation('android', bridge, async () => {
        requests++
        return true
      })
    ).property('status', 'success')
    expect(requests).equals(1)
    expect(configs[0]).deep.equals({
      authorizationLevel: 'whenInUse',
      enableBackgroundLocationUpdates: false,
      locationProvider: 'android',
      skipPermissionRequests: true
    })
    expect(
      await requestNativeRoughLocation('ios', bridge, async () => {
        throw new Error('Android permission must not be requested')
      })
    ).property('status', 'success')
    expect(configs[1]).property('skipPermissionRequests', false)
    expect(
      await requestNativeRoughLocation('android', bridge, async () => false)
    ).deep.equals({ status: 'denied' })
    expect(
      await requestNativeRoughLocation('android', bridge, async () => {
        throw new Error('Provider unavailable')
      })
    ).deep.equals({ status: 'unavailable' })
  })
})
