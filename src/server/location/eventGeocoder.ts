import type { Kysely } from 'kysely'

import { HttpError, unavailable } from '../../common/errors'
import { isRecord } from '../../common/groupCreation'
import type { Database } from '../db/database'
import type { GooglePlaces } from './googlePlaces'

export interface Coordinates {
  latitude: number
  longitude: number
}
export interface EventGeocoder {
  usesGoogle?: boolean
  lookup: (address: string) => Promise<Coordinates>
}

export function photonCoordinates(raw: unknown): Coordinates {
  const features = isRecord(raw) ? raw.features : undefined
  const feature = Array.isArray(features) ? features[0] : undefined
  const geometry = isRecord(feature) ? feature.geometry : undefined
  const coordinates = isRecord(geometry) ? geometry.coordinates : undefined
  if (
    !Array.isArray(coordinates) ||
    coordinates.length < 2 ||
    typeof coordinates[0] !== 'number' ||
    typeof coordinates[1] !== 'number' ||
    !Number.isFinite(coordinates[0]) ||
    !Number.isFinite(coordinates[1]) ||
    Math.abs(coordinates[0]) > 180 ||
    Math.abs(coordinates[1]) > 90
  )
    throw unavailable(
      'The address could not be located. Check it or try again.'
    )
  return { longitude: coordinates[0], latitude: coordinates[1] }
}

/** Lookup only on an Info view, with persistent positive caching and bounded work. */
export function eventGeocoder(
  db: Kysely<Database>,
  options: {
    url?: string
    fetch?: typeof fetch
    spacingMs?: number
    timeoutMs?: number
    failureTtlMs?: number
    now?: () => number
    googlePlaces?: GooglePlaces
  } = {}
): EventGeocoder {
  const provider =
    options.url ??
    process.env.TS_EVENT_GEOCODER_URL ??
    'https://photon.komoot.io/api/'
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  // This cache belongs to the fallback provider. Google lookups always precede it
  // and their coordinates never enter its indefinite positive cache.
  const google = options.googlePlaces
  const fallback =
    google == null
      ? undefined
      : eventGeocoder(db, { ...options, googlePlaces: undefined })
  const inFlight = new Map<string, Promise<Coordinates>>()
  const failed = new Map<string, number>()
  let tail: Promise<unknown> = Promise.resolve()
  let lastStart = 0
  return {
    usesGoogle: google != null,
    async lookup(address) {
      const key = address.trim().toLowerCase()
      if (google != null) {
        const existing = inFlight.get(key)
        if (existing != null) return await existing
        if (inFlight.size >= 8)
          throw unavailable('The map is busy. Try again shortly.')
        const work = google
          .coordinates(address)
          .catch(async (error: unknown) => {
            if (!(error instanceof HttpError) || error.code !== 'unavailable')
              throw error
            return await fallback!.lookup(address)
          })
          .finally(() => inFlight.delete(key))
        inFlight.set(key, work)
        return await work
      }
      const cached = await db
        .selectFrom('event_geocodes')
        .select(['latitude', 'longitude'])
        .where('address', '=', key)
        .executeTakeFirst()
      if (cached != null) return cached
      const pending = inFlight.get(key)
      if (pending != null) return await pending
      if ((failed.get(key) ?? 0) > now())
        throw unavailable(
          'The map is temporarily unavailable. Try again shortly.'
        )
      if (inFlight.size >= 8)
        throw unavailable('The map is busy. Try again shortly.')
      const work = tail
        .then(async () => {
          const delay = Math.max(
            0,
            lastStart + (options.spacingMs ?? 1000) - now()
          )
          if (delay > 0)
            await new Promise(resolve => setTimeout(resolve, delay))
          lastStart = now()
          const url = new URL(provider)
          url.searchParams.set('q', address)
          url.searchParams.set('limit', '1')
          const response = await doFetch(url, {
            signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
            headers: {
              'User-Agent': 'TeamStation/1.0 (+https://app.teamstation.app)',
              accept: 'application/json'
            }
          })
          if (!response.ok)
            throw unavailable(
              'The map provider is unavailable. Try again shortly.'
            )
          const result = photonCoordinates(await response.json())
          await db
            .insertInto('event_geocodes')
            .values({ address: key, ...result })
            .onConflict(oc =>
              oc
                .column('address')
                .doUpdateSet({ ...result, updated_at: new Date() })
            )
            .execute()
          failed.delete(key)
          return result
        })
        .catch(() => {
          if (failed.size >= 256) failed.delete(failed.keys().next().value!)
          failed.set(key, now() + (options.failureTtlMs ?? 10000))
          throw unavailable(
            'The address could not be located. Check it or try again shortly.'
          )
        })
        .finally(() => {
          inFlight.delete(key)
        })
      inFlight.set(key, work)
      tail = work.catch(() => undefined)
      return await work
    }
  }
}
