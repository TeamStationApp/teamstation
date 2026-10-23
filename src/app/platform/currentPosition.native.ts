import Geolocation from '@react-native-community/geolocation'

import { type Position, POSITION_TIMEOUT_MS } from './position'

export type { Position } from './position'

/**
 * Where the person is now, asking the phone's permission the first time, or
 * null when they refuse or the phone cannot tell in time.
 */
export async function currentPosition(): Promise<Position | null> {
  return await new Promise(resolve => {
    Geolocation.getCurrentPosition(
      found => {
        resolve({
          latitude: found.coords.latitude,
          longitude: found.coords.longitude
        })
      },
      () => {
        resolve(null)
      },
      {
        enableHighAccuracy: false,
        timeout: POSITION_TIMEOUT_MS,
        maximumAge: 10 * 60 * 1000
      }
    )
  })
}
