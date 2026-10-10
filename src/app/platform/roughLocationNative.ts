import {
  type LocationProvider,
  requestRoughLocation,
  roughLocationOptions,
  type RoughLocationResult
} from './roughLocation'

export interface NativeLocationBridge {
  setRNConfiguration: (options: {
    authorizationLevel: 'whenInUse'
    enableBackgroundLocationUpdates: boolean
    locationProvider: 'android'
    skipPermissionRequests: boolean
  }) => void
  getCurrentPosition: (
    success: Parameters<LocationProvider>[0],
    error: Parameters<LocationProvider>[1],
    options: typeof roughLocationOptions
  ) => void
}

/** Injectable bridge keeps OS permission wiring distinct from the tested decision logic. */
export async function requestNativeRoughLocation(
  platform: string,
  bridge: NativeLocationBridge,
  requestCoarsePermission: () => Promise<boolean>
): Promise<RoughLocationResult> {
  try {
    bridge.setRNConfiguration({
      authorizationLevel: 'whenInUse',
      enableBackgroundLocationUpdates: false,
      locationProvider: 'android',
      skipPermissionRequests: platform === 'android'
    })
    if (platform === 'android' && !(await requestCoarsePermission()))
      return { status: 'denied' }
    return await requestRoughLocation((success, failure) => {
      bridge.getCurrentPosition(success, failure, roughLocationOptions)
    })
  } catch {
    return { status: 'unavailable' }
  }
}
