import type { PoolClient } from 'pg'

import type { Locality } from '../../common/locality'
import type { Migration } from '../runner'

/**
 * Gives leagues and teams the coordinates of their locality, so a search
 * near a city can measure how far each one is. A season has no locality of
 * its own and reads its league's.
 *
 * The backfill runs in TypeScript because the places catalog is the gzip
 * file the server loads, not a table. It delegates to the live
 * `placeCoordinates`, the same rule every later locality write applies: a
 * GeoNames place id maps to its catalog city; a Google place id, or a
 * locality without one, takes the most populous catalog city of the same
 * city, region and country; anything else stays null.
 */
export const migration126GroupCoordinates: Migration = {
  name: '126groupCoordinates',
  up: `
alter table leagues
  add column latitude double precision,
  add column longitude double precision;
alter table teams
  add column latitude double precision,
  add column longitude double precision;
`,
  down: `
alter table teams
  drop column longitude,
  drop column latitude;
alter table leagues
  drop column longitude,
  drop column latitude;
`,
  steps: async client => {
    // Read here, not at the top: the catalog is large, and a reader of the
    // migration list must not load it.
    const { placeCoordinates } = await import('../../server/location/places')
    for (const table of ['leagues', 'teams'] as const)
      await backfill(client, table, placeCoordinates)
  }
}

/** Sets each located row's coordinates, in one statement per table. */
async function backfill(
  client: PoolClient,
  table: 'leagues' | 'teams',
  coordinatesOf: (
    locality: Locality
  ) => { latitude: number; longitude: number } | null
): Promise<void> {
  const { rows } = await client.query<{ id: string; locality: unknown }>(
    `select id, locality from ${table} where locality is not null`
  )
  const ids: string[] = []
  const latitudes: number[] = []
  const longitudes: number[] = []
  for (const row of rows) {
    const locality = storedLocality(row.locality)
    const found = locality == null ? null : coordinatesOf(locality)
    if (found == null) continue
    ids.push(row.id)
    latitudes.push(found.latitude)
    longitudes.push(found.longitude)
  }
  if (ids.length === 0) return
  await client.query(
    `update ${table} set latitude = located.latitude, longitude = located.longitude
       from unnest($1::text[], $2::float8[], $3::float8[])
         as located(id, latitude, longitude)
      where ${table}.id = located.id`,
    [ids, latitudes, longitudes]
  )
}

/** A stored locality, or null when it lacks a city, region or country. */
function storedLocality(raw: unknown): Locality | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const { city, region, country, placeId, timezone } = value
  if (
    typeof city !== 'string' ||
    typeof region !== 'string' ||
    typeof country !== 'string'
  )
    return null
  return {
    city,
    region,
    country,
    placeId: typeof placeId === 'string' ? placeId : null,
    timezone: typeof timezone === 'string' ? timezone : 'UTC'
  }
}
