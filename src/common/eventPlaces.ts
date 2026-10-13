import { asArray, asObject, asOptional, asString } from 'cleaners'

import { asLiteral } from './asLiteral'

export type EventPlaceKind = 'venue' | 'address'
export const asEventPlace = asObject({
  id: asString,
  name: (raw: unknown): string | null => (raw == null ? null : asString(raw)),
  address: asString
})
export type EventPlace = ReturnType<typeof asEventPlace>
export const asEventPlaces = asObject({
  places: asArray(asEventPlace),
  provider: asOptional(asLiteral('google', 'openstreetmap'), 'openstreetmap'),
  attribution: asOptional(asString, '© OpenStreetMap contributors')
})

/** An address only supplies a name when the draft has none. */
export function selectedEventPlace(
  kind: EventPlaceKind,
  place: EventPlace,
  currentName: string
): { venue: string; address: string } {
  return {
    venue:
      kind === 'venue' || currentName.trim() === ''
        ? (place.name ?? currentName)
        : currentName,
    address: place.address
  }
}
