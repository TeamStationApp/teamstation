import { getRoughLocation as nativeLocation } from '../app/platform/getRoughLocation.native'
import {
  requestRoughLocation,
  type RoughLocationResult
} from '../app/platform/roughLocation'

// React Native supplies this fixed global name.
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __DEV__: boolean
declare const process: { env: Record<string, string | undefined> }

/** Only Metro's explicit native test override resolves this module. */
export async function getRoughLocation(): Promise<RoughLocationResult> {
  if (!__DEV__) return await nativeLocation()
  if (process.env.TS_CREATION_NATIVE_LOCATION_FAILURE === 'unavailable')
    return { status: 'unavailable' }
  if (process.env.TS_CREATION_NATIVE_LOCATION_FAILURE !== 'timeout')
    throw new Error('Native failure fixture requires an explicit mode')
  return await requestRoughLocation(success => {
    // The real ten-second adapter deadline wins. A late provider callback
    // then arrives while the user has moved on to their manual choice.
    setTimeout(() => {
      success({ coords: { latitude: 40.7128, longitude: -74.006 } })
    }, 20000)
  })
}
