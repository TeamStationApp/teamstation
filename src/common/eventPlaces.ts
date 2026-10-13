import { asArray, asObject, asString } from 'cleaners'

export type EventPlaceKind = 'venue' | 'address'
export const asEventPlace = asObject({
  id: asString,
  name: (raw: unknown): string | null => (raw == null ? null : asString(raw)),
  address: asString
})
export type EventPlace = ReturnType<typeof asEventPlace>
export const asEventPlaces = asObject({ places: asArray(asEventPlace) })

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
