import { type Position, POSITION_TIMEOUT_MS } from './position'

export type { Position } from './position'

/**
 * Where the person is now, from the browser, or null when they refuse, the
 * browser cannot tell, or it takes too long. "Nearby" is measured from here.
 */
export async function currentPosition(
  geolocation: Geolocation | undefined = globalThis.navigator?.geolocation
): Promise<Position | null> {
  if (geolocation == null) return null
  return await new Promise(resolve => {
    geolocation.getCurrentPosition(
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
