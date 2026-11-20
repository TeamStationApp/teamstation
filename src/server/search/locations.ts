import {
  fold,
  type MatchScore,
  matchScore,
  wordsOf
} from '../../common/search/match'
import {
  COUNTRY_ABBREVIATIONS,
  countryName,
  placeLabel,
  regionAbbreviation
} from '../../common/search/places'
import {
  cityLocationId,
  countryLocationId,
  type Location,
  regionLocationId
} from '../../common/search/types'
import {
  type Build,
  catalogPlace,
  findPlaces,
  type GeoPoint,
  milesToNearest,
  type Place,
  placeCatalog,
  runCooperatively,
  runNow,
  warmPlaces
} from '../location/places'

/**
 * The location pills a search suggests, from the GeoNames catalog the city
 * lookup reads: cities by `findPlaces`, and regions and countries whose name
 * or abbreviation each typed word starts. They are ranked by how well they
 * match, then by population (given where the reader is, by population
 * falling with distance): the first `LOCATIONS_SHOWN` are the
 * lexicographic answer's, and the first `LOCATIONS_FOR_JEV` are Jev's to
 * re-rank.
 */
export const LOCATIONS_SHOWN = 4
export const LOCATIONS_FOR_JEV = 12

/** A suggested pill, with what it was ranked by. */
export interface FoundLocation {
  location: Location
  population: number
  score: MatchScore
}

interface Area {
  location: Location
  population: number
  /** The name's words. */
  name: string[]
  /** Its abbreviations, folded, as further words. */
  short: string[]
}

interface Areas {
  /**
   * The catalog's regions and countries by the first two letters of each
   * of their words and abbreviations (a one-letter word by its letter): a
   * typed word of two letters or more can start only the words of its
   * first two letters' areas.
   */
  byStart: Map<string, Area[]>
  /** Each country's words a city pill is matched on, by its code. */
  countryWords: Map<string, string[]>
}

const areasOf = new WeakMap<Place[], Areas>()

function fullCountryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * Every region and country of the catalog, with its population summed, by
 * the starts of their words; and each country's words.
 */
function areas(rows: Place[]): Areas {
  return areasOf.get(rows) ?? runNow(areasBuild(rows))
}

/** Builds `areas`, giving way as it goes (`Build`), unless they are built. */
function* areasBuild(rows: Place[]): Build<Areas> {
  const known = areasOf.get(rows)
  if (known != null) return known
  const regions = new Map<string, Area>()
  const countries = new Map<string, Area>()
  for (let at = 0; at < rows.length; ++at) {
    if (at % AREA_STEP === 0) yield
    const place = rows[at]
    const [, , region, country] = place
    let nation = countries.get(country)
    if (nation == null) {
      const shortName = COUNTRY_ABBREVIATIONS[country]
      nation = {
        location: {
          kind: 'country',
          id: countryLocationId(country),
          label: countryName(country),
          country
        },
        population: 0,
        name: wordsOf(fullCountryName(country)),
        short: [fold(country), ...(shortName == null ? [] : [fold(shortName)])]
      }
      countries.set(country, nation)
    }
    nation.population += place[7]
    if (region === '') continue
    const key = `${country}\n${region}`
    let area = regions.get(key)
    if (area == null) {
      const abbreviation = regionAbbreviation(country, region)
      area = {
        location: {
          kind: 'region',
          id: regionLocationId(country, region),
          label: placeLabel({ kind: 'region', region, country }),
          region,
          country
        },
        population: 0,
        name: wordsOf(region),
        short: abbreviation == null ? [] : [fold(abbreviation)]
      }
      regions.set(key, area)
    }
    area.population += place[7]
  }
  const byStart = new Map<string, Area[]>()
  const countryWords = new Map<string, string[]>()
  for (const area of [...regions.values(), ...countries.values()]) {
    for (const start of new Set(
      [...area.name, ...area.short].map(word => word.slice(0, 2))
    )) {
      const same = byStart.get(start)
      if (same == null) byStart.set(start, [area])
      else same.push(area)
    }
    if (area.location.kind === 'country')
      countryWords.set(area.location.country, [
        ...area.name,
        fold(area.location.country)
      ])
  }
  // A first use while this was building built its own: that one stands.
  const built = areasOf.get(rows)
  if (built != null) return built
  const found = { byStart, countryWords }
  areasOf.set(rows, found)
  return found
}

/** How many catalog rows `areasBuild` reads between its yields. */
const AREA_STEP = 1024

let warming: Promise<void> | undefined

/**
 * Builds everything `findLocations` reads on its first call: the catalog's
 * places and their indexes (`warmPlaces`), and its regions and countries by
 * the starts of their words, in stretches that leave the event loop free
 * between them (`runCooperatively`). A server worker calls it once it
 * listens; with no rows it warms the catalog once, and `locationsReady`
 * waits for it.
 */
export async function warmLocations(rows?: Place[]): Promise<void> {
  if (rows != null) {
    await warmPlaces(rows)
    await runCooperatively(areasBuild(rows))
    return
  }
  warming ??= (async () => {
    await warmPlaces()
    await runCooperatively(areasBuild(placeCatalog()))
  })()
  await warming
}

/**
 * Starts `warm` (`warmLocations`, by default) without waiting for it, and
 * writes how it went: how long the search places took to be ready, or why
 * they were not. A server worker calls it once it listens.
 */
export function warmLocationsInBackground(
  log: (line: string) => void,
  warm: () => Promise<void> = warmLocations
): void {
  const startedAt = performance.now()
  warm().then(
    () => {
      log(
        `search places ready in ${Math.round(performance.now() - startedAt)} ms`
      )
    },
    (error: unknown) => {
      log(`search places not warmed: ${String(error)}`)
    }
  )
}

/**
 * Resolves once `warmLocations` has warmed the catalog, at once when nothing
 * warms it. It never rejects: after a failed warm, `findLocations` builds
 * what it reads itself. The search engine waits for it before it suggests a
 * pill, so a search during the warm waits rather than holding the event
 * loop for the whole build.
 */
export async function locationsReady(): Promise<void> {
  await warming?.catch(() => undefined)
}

/** Whether every typed word starts one of the area's words. */
function startsArea(typed: string[], area: Area): MatchScore | null {
  const score = matchScore(typed, { name: area.name, place: area.short })
  if (score.matched < typed.length) return null
  if (score.words.some(kind => kind === 'substring')) return null
  return score
}

/** A catalog city as a pill. */
export function cityLocation(place: Place): Location {
  const [id, city, region, country, latitude, longitude] = place
  return {
    kind: 'city',
    id: cityLocationId(id),
    label: placeLabel({ kind: 'city', city, region, country }),
    city,
    region,
    country,
    latitude,
    longitude
  }
}

/**
 * Where a reader is, for ranking pills: a point, and the region and country
 * (catalog form: `California`, `US`) it lies in when they are known.
 */
export interface NearPoint extends GeoPoint {
  region?: string
  country?: string
}

/**
 * Miles from a pill to the reader: a city's to the nearest of their points;
 * a region or country 0 when one of their points lies in it, else
 * `AREA_AWAY_MILES`.
 */
export function milesFromReader(
  location: Location,
  near: readonly NearPoint[]
): number {
  const { latitude, longitude } = location
  if (latitude != null && longitude != null)
    return milesToNearest({ latitude, longitude }, near)
  // DB-IP spells a region as GeoNames does but for case and accents.
  const region = fold(location.region ?? '')
  const holds = near.some(
    point =>
      point.country === location.country &&
      (location.kind === 'country' || fold(point.region ?? '') === region)
  )
  return holds ? 0 : AREA_AWAY_MILES
}

/** How far off a region or country the reader is not in counts as being. */
const AREA_AWAY_MILES = Infinity
/** The miles at which a place's pull on the reader falls to a quarter. */
const PULL_MILES = 50
/**
 * The reader's reach: places within it are ranked by their pull on the
 * reader, ahead of farther ones, which keep the order they have for a
 * reader nobody can place.
 */
export const REACH_MILES = 500
/**
 * The least pull a place in reach needs to be ranked by it: a town of a
 * thousand at the reader's door, or a city of 121,000 at the edge of reach.
 * A hamlet nearby keeps its place behind a well-known city farther off.
 */
export const PULL_MIN = 1000

/**
 * How strongly a place draws a reader: its population, falling with the
 * square of its distance from them. A city of a million 400 miles off still
 * outweighs a town of 50,000 down the road; a town of 100,000 nearby
 * outweighs a city of a million an ocean away.
 */
export function pullOn(
  location: Location,
  population: number,
  near: readonly NearPoint[]
): number {
  const away = 1 + milesFromReader(location, near) / PULL_MILES
  return population / (away * away)
}

/**
 * Best first: the most typed words matched, then how they matched. Among
 * pills matched as well, one whose own name holds typed letters comes before
 * one matched only through its region or country words. Given where the
 * reader is, a pill whose whole name was typed comes next, then those within
 * `REACH_MILES` of the reader (a region or country holding them) that draw
 * them at least `PULL_MIN`, strongest pull first (`pullOn`: population
 * falling with distance). Every other pill
 * keeps the order it has for a reader nobody can place: the most of the
 * name typed, then the most populous. Then the label and id.
 */
function compareFound(
  a: FoundLocation,
  b: FoundLocation,
  near: readonly NearPoint[]
): number {
  const named = (found: FoundLocation): number =>
    found.score.coverage > 0 ? 1 : 0
  const whole = (found: FoundLocation): number =>
    found.score.coverage >= 1 ? 1 : 0
  const pull = (found: FoundLocation): number =>
    pullOn(found.location, found.population, near)
  const within = (found: FoundLocation): number =>
    milesFromReader(found.location, near) <= REACH_MILES &&
    pull(found) >= PULL_MIN
      ? 1
      : 0
  const reached = near.length > 0 && within(a) + within(b) === 2
  const order = [
    b.score.matched - a.score.matched,
    b.score.points - a.score.points,
    named(b) - named(a),
    ...(near.length === 0 ? [] : [whole(b) - whole(a), within(b) - within(a)]),
    reached ? pull(b) - pull(a) : 0,
    b.score.coverage - a.score.coverage,
    b.population - a.population,
    a.location.label < b.location.label
      ? -1
      : a.location.label > b.location.label
        ? 1
        : 0,
    a.location.id < b.location.id ? -1 : a.location.id > b.location.id ? 1 : 0
  ]
  return order.find(step => step !== 0) ?? 0
}

/**
 * The pills for this text, best first, at most `LOCATIONS_FOR_JEV`. None
 * until a typed word has two letters: a single letter starts too many
 * places to name one.
 */
export function findLocations(
  text: string,
  rows: Place[] = placeCatalog(),
  near: readonly NearPoint[] = []
): FoundLocation[] {
  const typed = wordsOf(text)
  const longest = typed.reduce(
    (best, word) => (word.length > best.length ? word : best),
    ''
  )
  if (longest.length < 2) return []
  const { byStart, countryWords } = areas(rows)
  const found: FoundLocation[] = []
  for (const locality of findPlaces(text, rows, near)) {
    const place =
      locality.placeId == null
        ? undefined
        : catalogPlace(locality.placeId, rows)
    // A pill names its city's region; a catalog city with none is no pill.
    if (place == null || place[2] === '') continue
    const abbreviation = regionAbbreviation(place[3], place[2])
    const score = matchScore(typed, {
      name: wordsOf(place[1]),
      place: [
        ...wordsOf(place[2]),
        ...(abbreviation == null ? [] : [fold(abbreviation)]),
        ...(countryWords.get(place[3]) ?? [])
      ]
    })
    if (score.matched === 0) continue
    found.push({ location: cityLocation(place), population: place[7], score })
  }
  // Every typed word must start one of an area's words: the longest can
  // start only those of its first two letters.
  for (const area of byStart.get(longest.slice(0, 2)) ?? []) {
    const score = startsArea(typed, area)
    if (score != null)
      found.push({
        location: area.location,
        population: area.population,
        score
      })
  }
  const best = found
    .sort((a, b) => compareFound(a, b, near))
    .slice(0, LOCATIONS_FOR_JEV)
  const labels = distinctLabels(
    best.map(each => each.location),
    rows
  )
  return best.map((each, at) => ({ ...each, location: labels[at] }))
}

/**
 * These pills, each told apart from any other of them that would read the
 * same. Each label is worked out afresh from the pill's city, region and
 * country, so a pill labelled before is labelled the same again, and a
 * suffix another pill called for is gone once that pill is not among them.
 *
 * A city or region whose label another of them shares adds its country,
 * once (`San Juan, Puerto Rico` and `San Juan, Argentina`; a city
 * `City, AB, Country`); a country's label is its name already. Pills that
 * still read the same, such as two catalog cities of one name in one state
 * (GeoNames has no county to tell them by), are numbered by population: the
 * most populous keeps its label, the next reads `(2)`, then `(3)`, ties by
 * catalog id. The numbers stay with the same cities whatever order a stage
 * ranks them in.
 */
export function distinctLabels(
  locations: Location[],
  rows?: Place[]
): Location[] {
  const counted = (labels: string[]): Map<string, number> => {
    const seen = new Map<string, number>()
    for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1)
    return seen
  }
  const plain = locations.map(location => placeLabel(location))
  const shared = counted(plain)
  const withCountry = locations.map((location, at) =>
    location.kind === 'country' || (shared.get(plain[at]) ?? 0) < 2
      ? plain[at]
      : `${plain[at]}, ${countryName(location.country)}`
  )
  const still = counted(withCountry)
  const population = (location: Location): number =>
    location.kind === 'city' ? (catalogPlace(location.id, rows)?.[7] ?? 0) : 0
  const numbered = new Map<number, number>()
  for (const label of new Set(withCountry)) {
    if ((still.get(label) ?? 0) < 2) continue
    const twins = locations
      .flatMap((location, at) =>
        withCountry[at] === label
          ? [{ at, id: location.id, population: population(location) }]
          : []
      )
      .sort((a, b) =>
        b.population !== a.population
          ? b.population - a.population
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0
      )
    twins.forEach(({ at }, rank) => numbered.set(at, rank + 1))
  }
  return locations.map((location, at) => {
    const rank = numbered.get(at) ?? 1
    const label = rank === 1 ? withCountry[at] : `${withCountry[at]} (${rank})`
    return label === location.label ? location : { ...location, label }
  })
}

/**
 * A chosen city's coordinates: the ones the pill carries, or the catalog's
 * for its id.
 */
export function cityCoordinates(
  location: Location,
  rows?: Place[]
): { latitude: number; longitude: number } | null {
  if (location.latitude != null && location.longitude != null)
    return { latitude: location.latitude, longitude: location.longitude }
  const place = catalogPlace(location.id.replace(/^geonames:/, ''), rows)
  return place == null ? null : { latitude: place[4], longitude: place[5] }
}

/**
 * The folded spellings a stored locality may name a pill's region and
 * country by: the region in full or abbreviated, the country by its code,
 * its English name or its abbreviation.
 */
export function regionSpellings(country: string, region: string): string[] {
  const abbreviation = regionAbbreviation(country, region)
  return [
    ...new Set([
      fold(region),
      ...(abbreviation == null ? [] : [fold(abbreviation)])
    ])
  ]
}

export function countrySpellings(country: string): string[] {
  const shortName = COUNTRY_ABBREVIATIONS[country]
  return [
    ...new Set([
      fold(country),
      fold(fullCountryName(country)),
      ...(shortName == null ? [] : [fold(shortName)])
    ])
  ]
}
