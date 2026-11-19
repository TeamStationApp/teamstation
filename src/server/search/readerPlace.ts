import { type Kysely, sql } from 'kysely'

import type { Locality } from '../../common/locality'
import { placeLabel } from '../../common/search/places'
import type { Database } from '../db/database'
import type { IpPlace } from '../location/ipPlaces'
import {
  milesBetween,
  NEAR_MILES,
  placeNear,
  placesReady
} from '../location/places'
import type { NearPoint } from './locations'
import type { SearchReach } from './reach'

/** Where the reader is, and how to say it: a group's place, or their IP's. */
export interface ReaderPoint extends NearPoint {
  label: string
}

/** The most points a reader is ranked against. */
export const READER_POINTS_MAX = 20
/** The most group rows read for them; an administrator reaches every group. */
const GROUP_ROWS_MAX = 500

/**
 * `City, RG`; a region's or country's name for a place with no city; '' for
 * one with no country, which nothing names.
 */
const labelOf = (locality: Partial<Locality> | null): string =>
  locality?.country == null || locality.country === ''
    ? ''
    : placeLabel({
        kind: 'city',
        city: locality.city ?? '',
        region: locality.region ?? '',
        country: locality.country
      })

/**
 * The places of the reader's own teams and leagues (a season's, its
 * league's), each a point with its locality's label, region and country.
 */
export async function groupPoints(
  db: Kysely<Database>,
  reach: SearchReach
): Promise<ReaderPoint[]> {
  const teams = [...reach.teamIds]
  const leagues = [...reach.leagueIds]
  const seasons = [...reach.seasonIds]
  if (teams.length + leagues.length + seasons.length === 0) return []
  const { rows } = await sql<{
    latitude: number
    longitude: number
    locality: Partial<Locality> | null
  }>`
    select latitude, longitude, locality from (
      select 0 as kind, id, latitude, longitude, locality from teams
        where id = any(${teams}::text[]) and latitude is not null
      union all
      select 1 as kind, id, latitude, longitude, locality from leagues
        where (id = any(${leagues}::text[])
          or id in (select league_id from seasons where id = any(${seasons}::text[])))
          and latitude is not null
    ) as placed
    -- The same rows each time for a reader who reaches more than fit.
    order by kind, id
    limit ${GROUP_ROWS_MAX}
  `.execute(db)
  // A worker still warming the catalog finishes that first, a stretch at a
  // time, rather than have `placeNear` build it all at once.
  await placesReady()
  return rows.map(row => {
    const point = { latitude: row.latitude, longitude: row.longitude }
    // Named as the catalog names it (`US`, `California`), not as the
    // locality was written: one chosen through Google reads `United States`.
    const named = placeNear(point) ?? row.locality
    return {
      ...point,
      label: labelOf(named),
      ...(named?.region == null ? {} : { region: named.region }),
      ...(named?.country == null ? {} : { country: named.country })
    }
  })
}

/**
 * The points, one per coordinate, at most `READER_POINTS_MAX`: those with
 * the most of the others within `NEAR_MILES` first, then one with a label
 * before one without, then by label. The first is the reader's home area.
 */
export function homeFirst(points: ReaderPoint[]): ReaderPoint[] {
  const distinct = new Map<string, ReaderPoint>()
  for (const point of points)
    distinct.set(`${point.latitude},${point.longitude}`, point)
  const unique = [...distinct.values()]
  const company = new Map(
    unique.map(point => [
      point,
      unique.filter(other => milesBetween(point, other) <= NEAR_MILES).length
    ])
  )
  return unique
    .sort((a, b) =>
      company.get(b)! - company.get(a)! !== 0
        ? company.get(b)! - company.get(a)!
        : (a.label === '') !== (b.label === '')
          ? a.label === ''
            ? 1
            : -1
          : a.label < b.label
            ? -1
            : a.label > b.label
              ? 1
              : 0
    )
    .slice(0, READER_POINTS_MAX)
}

/** The IP's place as a point, labelled `City, RG`. */
export function ipPoint(place: IpPlace): ReaderPoint {
  return {
    latitude: place.latitude,
    longitude: place.longitude,
    label: labelOf(place),
    region: place.region,
    country: place.country
  }
}

/**
 * Where to rank places near for this reader: their own groups' places when
 * they are signed in and have any, else where their IP address is, else
 * nowhere.
 */
export async function readerPoints(
  db: Kysely<Database>,
  reach: (() => Promise<SearchReach>) | null,
  ipPlace: () => IpPlace | null | Promise<IpPlace | null>
): Promise<ReaderPoint[]> {
  if (reach != null) {
    const groups = homeFirst(await groupPoints(db, await reach()))
    if (groups.length > 0) return groups
  }
  const place = await ipPlace()
  return place == null ? [] : [ipPoint(place)]
}
