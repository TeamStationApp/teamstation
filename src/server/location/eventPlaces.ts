import { unavailable } from '../../common/errors'
import type { EventPlace, EventPlaceKind } from '../../common/eventPlaces'
import { isRecord } from '../../common/groupCreation'

export const VENUE_TAGS = [
  'amenity',
  'leisure',
  'tourism',
  'shop',
  'sport',
  'office',
  'historic',
  'building'
]
export const EVENT_PLACE_ATTRIBUTION = '© OpenStreetMap contributors'

export function photonPlaces(raw: unknown, kind: EventPlaceKind): EventPlace[] {
  if (!isRecord(raw) || !Array.isArray(raw.features))
    throw unavailable(
      'Place suggestions are unavailable. Enter details manually.'
    )
  const out: EventPlace[] = []
  const seen = new Set<string>()
  const text = (raw: unknown): string =>
    typeof raw === 'string' ? raw.trim() : ''
  for (const feature of raw.features.slice(0, 20)) {
    if (!isRecord(feature) || !isRecord(feature.properties)) continue
    const p = feature.properties
    const isVenue = VENUE_TAGS.includes(text(p.osm_key)) && text(p.name) !== ''
    if (kind === 'venue' && !isVenue) continue
    const street = [text(p.housenumber), text(p.street)]
      .filter(Boolean)
      .join(' ')
    const parts = [
      street === '' ? text(p.name) : street,
      text(p.city) === '' ? text(p.locality) : text(p.city),
      text(p.state),
      text(p.postcode),
      text(p.country)
    ].filter(Boolean)
    const address = [...new Set(parts)].join(', ')
    if (
      address === '' ||
      address.length > 500 ||
      (isVenue && text(p.name).length > 200)
    )
      continue
    const name = isVenue ? text(p.name) : null
    const sourceId =
      typeof p.osm_id === 'number' || typeof p.osm_id === 'string'
        ? String(p.osm_id)
        : address
    const id = `${text(p.osm_type)}:${sourceId}:${name ?? ''}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name, address })
    if (out.length === 5) break
  }
  return out
}

export interface EventPlaceSearch {
  search: (query: string, kind: EventPlaceKind) => Promise<EventPlace[]>
}

/** Bound upstream work and cache only short-lived suggestions; never audit query text. */
export function eventPlaceSearch(
  options: {
    fetch?: typeof fetch
    url?: string
    spacingMs?: number
    timeoutMs?: number
    now?: () => number
  } = {}
): EventPlaceSearch {
  const now = options.now ?? Date.now
  const cache = new Map<string, { until: number; places: EventPlace[] }>()
  const pending = new Map<string, Promise<EventPlace[]>>()
  let tail: Promise<unknown> = Promise.resolve()
  let lastStart = 0
  return {
    async search(query, kind) {
      const trimmed = query.trim()
      if (trimmed.length < 2) return []
      const key = `${kind}:${trimmed.toLowerCase()}`
      const cached = cache.get(key)
      if (cached != null && cached.until > now()) return cached.places
      const existing = pending.get(key)
      if (existing != null) return await existing
      if (pending.size >= 8)
        throw unavailable(
          'Place lookup is busy. Enter details manually or try again.'
        )
      const work = tail
        .then(async () => {
          const delay = Math.max(
            0,
            lastStart + (options.spacingMs ?? 1000) - now()
          )
          if (delay > 0)
            await new Promise(resolve => setTimeout(resolve, delay))
          lastStart = now()
          const url = new URL(
            options.url ??
              process.env.TS_EVENT_GEOCODER_URL ??
              'https://photon.komoot.io/api/'
          )
          url.searchParams.set('q', trimmed)
          url.searchParams.set('limit', '10')
          if (kind === 'venue')
            for (const tag of VENUE_TAGS)
              url.searchParams.append('osm_tag', tag)
          const response = await (options.fetch ?? fetch)(url, {
            signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
            headers: {
              accept: 'application/json',
              'User-Agent': 'TeamStation/1.0 (+https://app.teamstation.app)'
            }
          })
          if (!response.ok) throw new Error('Provider unavailable')
          const places = photonPlaces(await response.json(), kind)
          if (cache.size >= 128) cache.delete(cache.keys().next().value!)
          cache.set(key, { places, until: now() + 60000 })
          return places
        })
        .catch(() => {
          throw unavailable(
            'Place suggestions are unavailable. Enter details manually or try again.'
          )
        })
        .finally(() => pending.delete(key))
      pending.set(key, work)
      tail = work.catch(() => undefined)
      return await work
    }
  }
}
