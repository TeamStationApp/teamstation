export interface Locality {
  city: string
  region: string
  country: string
  placeId: string | null
  timezone: string
}

function text(raw: unknown, name: string, max = 120): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim().length > max)
    throw new TypeError(`Enter a valid ${name}`)
  return raw.trim()
}

export function asLocality(raw: unknown): Locality {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
    throw new TypeError('Choose a city and state or region')
  const value = raw as Record<string, unknown>
  const timezone = text(value.timezone, 'timezone')
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
  } catch {
    throw new TypeError('Choose a valid timezone')
  }
  return {
    city: text(value.city, 'city'),
    region: text(value.region, 'state or region'),
    country: text(value.country, 'country', 80),
    placeId: value.placeId == null ? null : text(value.placeId, 'place id', 30),
    timezone
  }
}

export function localityLabel(value: Locality | null): string {
  return value == null
    ? 'Location not set'
    : `${value.city}, ${value.region}, ${value.country}`
}
