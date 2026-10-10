import {
  requestRoughLocation,
  roughLocationOptions,
  type RoughLocationResult
} from './roughLocation'

export async function getRoughLocation(): Promise<RoughLocationResult> {
  if (typeof navigator === 'undefined' || navigator.geolocation == null)
    return { status: 'unavailable' }
  return await requestRoughLocation((success, failure) => {
    navigator.geolocation.getCurrentPosition(
      success,
      failure,
      roughLocationOptions
    )
  })
}
