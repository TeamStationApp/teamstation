import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import type { Locality } from '../../common/locality'
import catalog from './placesCatalogMeta.json'

export type Place = [
  id: string,
  city: string,
  region: string,
  country: string,
  latitude: number,
  longitude: number,
  timezone: string,
  population: number
]
const places = JSON.parse(
  gunzipSync(readFileSync(join(__dirname, 'placesCatalog.json.gz'))).toString()
) as Place[]
export const placeAttribution = catalog.attribution
export const placeSnapshot = {
  retrievedOn: catalog.retrievedOn,
  sha256: catalog.sourceSha256
}

function locality(place: Place): Locality {
  return {
    placeId: place[0],
    city: place[1],
    region: place[2],
    country: place[3],
    timezone: place[6]
  }
}
export function placeById(id: string): Locality | undefined {
  const place = places.find(row => row[0] === id)
  return place == null ? undefined : locality(place)
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Search public reference locations, never a user/device directory. */
export function findPlaces(query: string, rows: Place[] = places): Locality[] {
  const terms = fold(query.trim())
    .split(/[\s,]+/)
    .filter(Boolean)
  if (terms.length === 0) return []
  return rows
    .filter(place => {
      const text = fold(`${place[1]} ${place[2]} ${place[3]}`)
      return terms.every(term => text.includes(term))
    })
    .sort((a, b) => (b[7] !== a[7] ? b[7] - a[7] : a[0].localeCompare(b[0])))
    .slice(0, 15)
    .map(locality)
}

/** Only the public locality leaves this function; device coordinates are not retained. */
export function nearestPlace(
  latitude: number,
  longitude: number,
  rows: Place[] = places
): Locality | null {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw new TypeError('Location estimate is invalid')
  let nearest: Place | undefined
  let minimum = Infinity
  const radians = Math.PI / 180
  for (const place of rows) {
    const deltaLat = (place[4] - latitude) * radians
    const deltaLon = (place[5] - longitude) * radians
    const distance =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(latitude * radians) *
        Math.cos(place[4] * radians) *
        Math.sin(deltaLon / 2) ** 2
    if (distance < minimum) {
      minimum = distance
      nearest = place
    }
  }
  return nearest == null ? null : locality(nearest)
}
