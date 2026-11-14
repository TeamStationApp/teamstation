import type { EventLocation } from '../../common/eventInfo'

/**
 * The event's point, checked before any map draws it. The Info tab already
 * shows its own error for a location the server could not find, so this
 * throw is a render guard for a malformed point.
 */
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
