import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { gunzip, gunzipSync } from 'node:zlib'

import type { Locality } from '../../common/locality'
import { fold } from '../../common/search/match'
import {
  COUNTRY_ABBREVIATIONS,
  countryName,
  regionAbbreviation
} from '../../common/search/places'
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
/**
 * A build that gives way: it yields every so many steps, so `runNow` can run
 * it to its end at once, or `runCooperatively` in short stretches.
 */
export type Build<T> = Generator<void, T, void>

/** How long one stretch of a cooperative build holds the event loop. */
export const BUILD_SLICE_MS = 8

/** Runs a build to its end at once, as a first use that cannot wait does. */
export function runNow<T>(build: Build<T>): T {
  for (;;) {
    const step = build.next()
    if (step.done === true) return step.value
  }
}

/**
 * Runs a build in stretches of about `sliceMs`, giving the event loop a turn
 * (`setImmediate`) between them, so requests are answered while it runs.
 */
export async function runCooperatively<T>(
  build: Build<T>,
  sliceMs = BUILD_SLICE_MS
): Promise<T> {
  let started = performance.now()
  for (;;) {
    const step = build.next()
    if (step.done === true) return step.value
    if (performance.now() - started < sliceMs) continue
    await new Promise(resolve => setImmediate(resolve))
    started = performance.now()
  }
}

/** How many steps of a build go between its yields. */
const STEP = 1024
/** How many catalog rows `parseRows` reads at a time. */
const PARSE_ROWS = 2000

/**
 * The catalog's rows from its JSON text, `[[…],[…],…]`, `PARSE_ROWS` at a
 * time: each run of rows is cut at a `],[` between two of them and read by
 * itself. A cut that falls inside a name (one holding `],[`) reads as no
 * JSON, and the run is taken on to the next `],[`.
 */
export function* parseRows(text: string): Build<Place[]> {
  const rows: Place[] = []
  const end = text.lastIndexOf(']')
  let start = text.indexOf('[') + 1
  if (start === 0 || end < start) throw new SyntaxError('Expected a JSON array')
  for (;;) {
    while (start < end && /\s/.test(text[start])) ++start
    if (start >= end) break
    let cut = start
    for (let n = 0; n < PARSE_ROWS && cut !== -1; ++n)
      cut = text.indexOf('],[', cut + 1)
    for (;;) {
      const stop = cut === -1 || cut >= end ? end : cut + 1
      try {
        const run = JSON.parse(`[${text.slice(start, stop)}]`) as Place[]
        for (const row of run) rows.push(row)
        start = stop + 1
        break
      } catch (error) {
        if (stop === end) throw error
        cut = text.indexOf('],[', cut + 1)
      }
    }
    yield
  }
  return rows
}

const catalogPath = join(__dirname, 'placesCatalog.json.gz')

let loaded: Place[] | undefined
/**
 * The catalog, read on first use rather than on import: what imports this
 * module for a locality write (group creation, the group update) loads the
 * catalog only once it looks a place up. A first use while `warmPlaces` is
 * still reading it reads it at once.
 */
function catalogPlaces(): Place[] {
  loaded ??= JSON.parse(
    gunzipSync(readFileSync(catalogPath)).toString()
  ) as Place[]
  return loaded
}

/** The catalog, read off the event loop and parsed in stretches. */
async function loadCatalog(): Promise<Place[]> {
  if (loaded != null) return loaded
  const zipped = await readFile(catalogPath)
  const text = (await promisify(gunzip)(zipped)).toString()
  const rows = await runCooperatively(parseRows(text))
  loaded ??= rows
  return loaded
}
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
  const place = indexOf(catalogPlaces()).byId.get(id)
  return place == null ? undefined : locality(place)
}

/** Where a league or team is, as the search measures distance from it. */
export interface Coordinates {
  latitude: number
  longitude: number
}

/** A catalog's places by id, and by folded city name. */
interface PlaceIndex {
  byId: Map<string, Place>
  byCity: Map<string, Place[]>
  /** What `findPlaces` reads, built on its first call. */
  search?: PlaceSearch
}

/**
 * The catalog as `findPlaces` searches it: its places in answer order (most
 * populous first, then by id) and each one's folded `city region country`
 * text. Every character of those texts but whitespace and commas (which no
 * typed term holds) has a letter: its own for the first `LETTERS_MAX` seen,
 * one shared by the rest. For each letter and each pair of adjacent
 * letters, the places whose text holds it are listed in answer order, one
 * gram's after another's in `places`. A shared letter lists more places
 * than any one of its characters is in; `findPlaces` still tests each
 * text, so it finds the same.
 */
interface PlaceSearch {
  ordered: Place[]
  texts: string[]
  /** Each UTF-16 code unit's letter, 0 for none. */
  letters: Uint16Array
  /** How many letters there are, with 0: the pairs' base. */
  base: number
  /** A gram's places run from `starts[gram]` to `starts[gram + 1]`. */
  starts: Int32Array
  places: Int32Array
}

const LETTERS_MAX = 1023

const indexes = new WeakMap<Place[], PlaceIndex>()

/** The catalog's index, built once on first use. */
function indexOf(rows: Place[]): PlaceIndex {
  return indexes.get(rows) ?? runNow(indexBuild(rows))
}

/** Builds the catalog's id and city index, unless one is built already. */
function* indexBuild(rows: Place[]): Build<PlaceIndex> {
  const index: PlaceIndex = { byId: new Map(), byCity: new Map() }
  for (let at = 0; at < rows.length; ++at) {
    if (at % STEP === 0) yield
    const place = rows[at]
    index.byId.set(place[0], place)
    const city = fold(place[1])
    const same = index.byCity.get(city)
    if (same == null) index.byCity.set(city, [place])
    else same.push(place)
  }
  // A first use while this was building built its own: that one stands.
  const built = indexes.get(rows)
  if (built != null) return built
  indexes.set(rows, index)
  return index
}

/**
 * Whether a locality's country names the catalog's code: the code itself,
 * its English name (Google's `United States`) or its abbreviation (`USA`).
 */
function sameCountry(written: string, code: string): boolean {
  const folded = fold(written.trim())
  if (folded === fold(code)) return true
  if (folded === fold(countryName(code))) return true
  // `countryName` gives an abbreviated country its abbreviation; its full
  // name still names it.
  if (!Object.hasOwn(COUNTRY_ABBREVIATIONS, code)) return false
  const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code)
  return name != null && folded === fold(name)
}

/** Whether a locality's region names the catalog's, in full or abbreviated. */
function sameRegion(written: string, place: Place): boolean {
  const folded = fold(written.trim())
  if (folded === fold(place[2])) return true
  const abbreviation = regionAbbreviation(place[3], place[2])
  return abbreviation != null && folded === fold(abbreviation)
}

function coordinatesOf(place: Place): Coordinates {
  return { latitude: place[4], longitude: place[5] }
}

/**
 * The coordinates a league's or team's locality is stored with. A GeoNames
 * place id (`geonames:<id>`, or the bare id the city lookup hands out) maps
 * to its catalog city. A Google place id, or a locality without one, takes
 * the most populous catalog city of the same folded city, region and
 * country. Anything else has none.
 */
export function placeCoordinates(
  locality: Locality | null | undefined,
  rows: Place[] = catalogPlaces()
): Coordinates | null {
  if (locality == null) return null
  const index = indexOf(rows)
  const placeId = locality.placeId
  if (placeId != null && !placeId.startsWith('google:')) {
    const id = placeId.startsWith('geonames:') ? placeId.slice(9) : placeId
    const place = index.byId.get(id)
    if (place != null) return coordinatesOf(place)
  }
  let best: Place | undefined
  for (const place of index.byCity.get(fold(locality.city.trim())) ?? []) {
    if (!sameRegion(locality.region, place)) continue
    if (!sameCountry(locality.country, place[3])) continue
    if (
      best == null ||
      place[7] > best[7] ||
      (place[7] === best[7] && place[0] < best[0])
    )
      best = place
  }
  return best == null ? null : coordinatesOf(best)
}

/** The whole catalog, read on first use: what Search's region and country pills are drawn from. */
export function placeCatalog(): Place[] {
  return catalogPlaces()
}

/** One catalog place by its GeoNames id, bare or `geonames:`-prefixed. */
export function catalogPlace(
  id: string,
  rows: Place[] = catalogPlaces()
): Place | undefined {
  return indexOf(rows).byId.get(id.startsWith('geonames:') ? id.slice(9) : id)
}

const ids = new Intl.Collator()

/** `findPlaces`'s order: most populous first, then by id. */
function answerOrder(a: Place, b: Place): number {
  return b[7] !== a[7] ? b[7] - a[7] : ids.compare(a[0], b[0])
}

/** Whether a character can sit in a typed term: never whitespace or a comma. */
function searched(code: number): boolean {
  if (code === 32 || code === 44) return false
  if (code < 128) return code > 13 || code < 9
  return !/\s/u.test(String.fromCharCode(code))
}

/**
 * Call `each` with every gram of a text: each searched character's letter,
 * and, for two adjacent searched characters, their pair's
 * (`base + first × base + second`).
 */
function eachGram(
  text: string,
  letters: Uint16Array,
  base: number,
  each: (gram: number) => void
): void {
  let before = 0
  for (let i = 0; i < text.length; ++i) {
    const letter = letters[text.charCodeAt(i)]
    if (letter !== 0) {
      each(letter)
      if (before !== 0) each(base + before * base + letter)
    }
    before = letter
  }
}

/**
 * These items in `compare`'s order, as a stable `sort` would put them: runs
 * of `STEP` sorted, then merged two by two, yielding as it goes.
 */
export function* sortedBy<T>(
  items: readonly T[],
  compare: (a: T, b: T) => number
): Build<T[]> {
  let from = [...items]
  for (let at = 0; at < from.length; at += STEP) {
    const run = from.slice(at, at + STEP).sort(compare)
    for (let i = 0; i < run.length; ++i) from[at + i] = run[i]
    yield
  }
  let into = new Array<T>(from.length)
  for (let width = STEP; width < from.length; width *= 2) {
    let out = 0
    for (let left = 0; left < from.length; left += 2 * width) {
      const middle = Math.min(left + width, from.length)
      const right = Math.min(left + 2 * width, from.length)
      let a = left
      let b = middle
      while (a < middle || b < right) {
        // The left run's first on a tie: the sort stays stable.
        into[out++] =
          b >= right || (a < middle && compare(from[a], from[b]) <= 0)
            ? from[a++]
            : from[b++]
        if (out % STEP === 0) yield
      }
    }
    ;[from, into] = [into, from]
  }
  return from
}

function searchOf(rows: Place[]): PlaceSearch {
  return indexOf(rows).search ?? runNow(searchBuild(rows))
}

/** Builds `findPlaces`'s index of the catalog, unless one is built already. */
function* searchBuild(rows: Place[]): Build<PlaceSearch> {
  let index = indexes.get(rows)
  // Not `??=`: sucrase compiles it into a function, where `yield*` cannot be.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (index == null) index = yield* indexBuild(rows)
  if (index.search != null) return index.search
  const ordered = yield* sortedBy(rows, answerOrder)
  const texts = new Array<string>(ordered.length)
  for (let at = 0; at < ordered.length; ++at) {
    if (at % STEP === 0) yield
    const place = ordered[at]
    texts[at] = fold(`${place[1]} ${place[2]} ${place[3]}`)
  }
  const letters = new Uint16Array(65_536)
  const unsearched = new Uint8Array(65_536)
  let seen = 0
  for (let at = 0; at < texts.length; ++at) {
    if (at % STEP === 0) yield
    const text = texts[at]
    for (let i = 0; i < text.length; ++i) {
      const code = text.charCodeAt(i)
      if (letters[code] !== 0 || unsearched[code] !== 0) continue
      if (searched(code)) letters[code] = Math.min(++seen, LETTERS_MAX + 1)
      else unsearched[code] = 1
    }
  }
  const base = Math.min(seen, LETTERS_MAX + 1) + 1
  const grams = base + base * base
  // Count each gram's places, then list them, each place once per gram.
  const starts = new Int32Array(grams + 1)
  const last = new Int32Array(grams).fill(-1)
  for (let at = 0; at < texts.length; ++at) {
    if (at % STEP === 0) yield
    eachGram(texts[at], letters, base, gram => {
      if (last[gram] === at) return
      last[gram] = at
      starts[gram + 1] += 1
    })
  }
  for (let gram = 0; gram < grams; ++gram) {
    if (gram % (STEP * 64) === 0) yield
    starts[gram + 1] += starts[gram]
  }
  const places = new Int32Array(starts[grams])
  const next = starts.slice(0, grams)
  last.fill(-1)
  for (let at = 0; at < texts.length; ++at) {
    if (at % STEP === 0) yield
    eachGram(texts[at], letters, base, gram => {
      if (last[gram] === at) return
      last[gram] = at
      places[next[gram]++] = at
    })
  }
  // A search while this was building built its own: that one stands.
  index.search ??= { ordered, texts, letters, base, starts, places }
  return index.search
}

let warming: Promise<void> | undefined

/**
 * Builds what the catalog's first search would: the catalog, its id and
 * city index, and `findPlaces`'s letter and pair index, in stretches of
 * about `BUILD_SLICE_MS` (`runCooperatively`), so a server worker that
 * calls it once it listens keeps answering requests while it runs. Called
 * with no rows, it warms the catalog once, and `placesReady` waits for it.
 *
 * A first use before it is done does not wait: it builds what it needs at
 * once, and answers as it would have.
 */
export async function warmPlaces(rows?: Place[]): Promise<void> {
  if (rows != null) {
    await runCooperatively(searchBuild(rows))
    return
  }
  warming ??= (async () => {
    await runCooperatively(searchBuild(await loadCatalog()))
  })()
  await warming
}

/**
 * Resolves once `warmPlaces` has warmed the catalog, at once when nothing
 * warms it; never rejects: a failed warm leaves each first use to build.
 */
export async function placesReady(): Promise<void> {
  await warming?.catch(() => undefined)
}

/**
 * The places a term can be in, most populous first: those holding its
 * letter, or its rarest pair of letters.
 */
function placesHolding(term: string, search: PlaceSearch): Int32Array {
  const { letters, base, starts, places } = search
  const holding = (gram: number): Int32Array =>
    places.subarray(starts[gram], starts[gram + 1])
  let fewest = places.subarray(0, 0)
  for (let i = 0; i < term.length; ++i) {
    const letter = letters[term.charCodeAt(i)]
    // A character no text holds: no place holds the term.
    if (letter === 0) return places.subarray(0, 0)
    if (term.length === 1) return holding(letter)
    if (i === 0) continue
    const pair = holding(base + letters[term.charCodeAt(i - 1)] * base + letter)
    if (i === 1 || pair.length < fewest.length) fewest = pair
  }
  return fewest
}

/**
 * Search public reference locations, never a user/device directory: the 15
 * most populous places whose folded `city region country` text holds every
 * typed term, then by id. Only the places that hold the rarest letter or
 * letter pair of a term are tested, most populous first, until 15 match.
 */
export function findPlaces(
  query: string,
  rows: Place[] = catalogPlaces()
): Locality[] {
  const terms = fold(query.trim())
    .split(/[\s,]+/)
    .filter(Boolean)
  if (terms.length === 0) return []
  const search = searchOf(rows)
  let candidates = placesHolding(terms[0], search)
  for (const term of terms.slice(1)) {
    const held = placesHolding(term, search)
    if (held.length < candidates.length) candidates = held
  }
  const found: Locality[] = []
  for (const at of candidates) {
    const text = search.texts[at]
    if (!terms.every(term => text.includes(term))) continue
    found.push(locality(search.ordered[at]))
    if (found.length === 15) break
  }
  return found
}

/** Only the public locality leaves this function; device coordinates are not retained. */
export function nearestPlace(
  latitude: number,
  longitude: number,
  rows: Place[] = catalogPlaces()
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

/**
 * The `latitude` and `longitude` columns a league or team row is written
 * with beside its locality: `placeCoordinates`, or nulls for none.
 */
export function coordinateColumns(locality: Locality | null | undefined): {
  latitude: number | null
  longitude: number | null
} {
  const found = placeCoordinates(locality)
  return {
    latitude: found?.latitude ?? null,
    longitude: found?.longitude ?? null
  }
}
