import { find } from 'geo-tz/dist/find-all'

import { unavailable } from '../../common/errors'
import { isRecord } from '../../common/groupCreation'

function validZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 120)
    return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

/** Google is primary; exact boundary data replaces a nearest-city estimate on failure. */
export async function coordinateTimezone(
  latitude: number,
  longitude: number,
  options: {
    apiKey: string
    baseUrl?: string
    timeoutMs?: number
    fetch?: typeof fetch
  }
): Promise<string> {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw unavailable('City lookup returned invalid coordinates')
  const url = new URL(
    '/maps/api/timezone/json',
    options.baseUrl ?? 'https://maps.googleapis.com'
  )
  url.searchParams.set('location', `${latitude},${longitude}`)
  url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)))
  url.searchParams.set('key', options.apiKey)
  try {
    const response = await (options.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000)
    })
    if (response.ok) {
      const result: unknown = await response.json()
      if (
        isRecord(result) &&
        result.status === 'OK' &&
        validZone(result.timeZoneId)
      )
        return result.timeZoneId
    }
  } catch {
    // Never log the request URL or keep Google's coordinates or response.
  }
  const timezone = find(latitude, longitude).find(validZone)
  if (timezone == null)
    throw unavailable('City time zone lookup is unavailable')
  return timezone
}
