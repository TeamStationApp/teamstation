export type RoughLocationResult =
  | { status: 'success'; latitude: number; longitude: number }
  | { status: 'denied' | 'unavailable' | 'timeout' }

export type LocationProvider = (
  success: (position: {
    coords: { latitude: number; longitude: number }
  }) => void,
  failure: (error: { code: number }) => void
) => void

export const roughLocationOptions = {
  enableHighAccuracy: false,
  timeout: 10000,
  maximumAge: 300000
}

/** One request, one result. A late provider result cannot replace a manual choice. */
export async function requestRoughLocation(
  provider: LocationProvider,
  deadlineMs = 10000
): Promise<RoughLocationResult> {
  return await new Promise(resolve => {
    let finished = false
    const finish = (result: RoughLocationResult): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ status: 'timeout' })
    }, deadlineMs)
    try {
      provider(
        position => {
          const { latitude, longitude } = position.coords
          finish(
            Number.isFinite(latitude) &&
              Number.isFinite(longitude) &&
              Math.abs(latitude) <= 90 &&
              Math.abs(longitude) <= 180
              ? { status: 'success', latitude, longitude }
              : { status: 'unavailable' }
          )
        },
        error => {
          finish({
            status:
              error.code === 1
                ? 'denied'
                : error.code === 3
                  ? 'timeout'
                  : 'unavailable'
          })
        }
      )
    } catch {
      finish({ status: 'unavailable' })
    }
  })
}
