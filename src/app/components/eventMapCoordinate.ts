import type { EventLocation } from '../../common/eventInfo'

/** The event's point for a native map, or the error the Info tab shows. */
export function eventMapCoordinate(location: EventLocation): {
  latitude: number
  longitude: number
} {
  const { latitude, longitude } = location
  if (
    latitude == null ||
    longitude == null ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw new Error('The address could not be located.')
  return { latitude, longitude }
}
