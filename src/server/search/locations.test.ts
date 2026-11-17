import { expect } from 'chai'
import { describe, it } from 'mocha'

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
  countryLocationId,
  type Location,
  regionLocationId
} from '../../common/search/types'
import {
  catalogPlace,
  findPlaces,
  type Place,
  placeCatalog
} from '../location/places'
import {
  cityCoordinates,
  cityLocation,
  countrySpellings,
  distinctLabels,
  findLocations,
  type FoundLocation,
  LOCATIONS_FOR_JEV,
  locationsReady,
  regionSpellings,
  warmLocations,
  warmLocationsInBackground
} from './locations'

const fullName = (code: string): string =>
  new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code

interface ScannedArea {
  location: Location
  population: number
  name: string[]
  short: string[]
}

const scanned = new WeakMap<Place[], ScannedArea[]>()

/** Every region and country of the catalog, as the old scan read them. */
function scannedAreas(rows: Place[]): ScannedArea[] {
  const known = scanned.get(rows)
  if (known != null) return known
  const areas = new Map<string, ScannedArea>()
  for (const place of rows) {
    const [, , region, country] = place
    const shortName = COUNTRY_ABBREVIATIONS[country]
    const nation = areas.get(country) ?? {
      location: {
        kind: 'country',
        id: countryLocationId(country),
        label: countryName(country),
        country
      },
      population: 0,
      name: wordsOf(fullName(country)),
      short: [fold(country), ...(shortName == null ? [] : [fold(shortName)])]
    }
    areas.set(country, nation)
    nation.population += place[7]
    if (region === '') continue
    const key = `${country}\n${region}`
    const abbreviation = regionAbbreviation(country, region)
    const area = areas.get(key) ?? {
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
    areas.set(key, area)
    area.population += place[7]
  }
  scanned.set(rows, [...areas.values()])
  return [...areas.values()]
}

/**
 * `findLocations` as it was before its index, kept as what it must answer
 * for text with a word of two letters or more: every region and country of
 * the catalog scored against every typed word on each call.
 */
function scanLocations(text: string, rows: Place[]): FoundLocation[] {
  const typed = wordsOf(text)
  if (typed.length === 0) return []
  const found: FoundLocation[] = []
  for (const locality of findPlaces(text, rows)) {
    const place = catalogPlace(locality.placeId ?? '', rows)
    if (place == null || place[2] === '') continue
    const abbreviation = regionAbbreviation(place[3], place[2])
    const score = matchScore(typed, {
      name: wordsOf(place[1]),
      place: [
        ...wordsOf(place[2]),
        ...(abbreviation == null ? [] : [fold(abbreviation)]),
        ...wordsOf(fullName(place[3])),
        fold(place[3])
      ]
    })
    if (score.matched === 0) continue
    found.push({ location: cityLocation(place), population: place[7], score })
  }
  for (const area of scannedAreas(rows)) {
    const score: MatchScore = matchScore(typed, {
      name: area.name,
      place: area.short
    })
    if (score.matched < typed.length) continue
    if (score.words.some(kind => kind === 'substring')) continue
    found.push({ location: area.location, population: area.population, score })
  }
  const order = (a: FoundLocation, b: FoundLocation): number =>
    [
      b.score.matched - a.score.matched,
      b.score.points - a.score.points,
      b.score.coverage - a.score.coverage,
      b.population - a.population,
      a.location.label < b.location.label
        ? -1
        : a.location.label > b.location.label
          ? 1
          : 0,
      a.location.id < b.location.id ? -1 : a.location.id > b.location.id ? 1 : 0
    ].find(step => step !== 0) ?? 0
  const best = found.sort(order).slice(0, LOCATIONS_FOR_JEV)
  const labels = distinctLabels(best.map(each => each.location))
  return best.map((each, at) => ({ ...each, location: labels[at] }))
}

/** The middle of several timings, in milliseconds. */
function medianMs(run: () => unknown, times = 9): number {
  const taken: number[] = []
  for (let i = 0; i < times; ++i) {
    const start = performance.now()
    run()
    taken.push(performance.now() - start)
  }
  return taken.sort((a, b) => a - b)[Math.floor(times / 2)]
}

const place = (
  id: string,
  city: string,
  region: string,
  country: string,
  population: number
): Place => [id, city, region, country, 40, -100, 'UTC', population]

const rows: Place[] = [
  place('901', 'Demo City', 'Demo Region', 'US', 5000),
  place('902', 'Demo City', 'Other Region', 'US', 9000),
  place('903', 'Demoville', 'Demo Region', 'US', 100),
  place('904', 'Springfield', 'California', 'US', 300),
  place('905', 'Halifax', 'Nova Scotia', 'CA', 400),
  place('906', 'Nowhere', '', 'US', 50_000)
]

const ids = (text: string, given: Place[] = rows): string[] =>
  findLocations(text, given).map(found => found.location.id)

describe('search location pills', () => {
  it('suggests nothing for text with no words', () => {
    expect(findLocations('', rows)).deep.equals([])
    expect(findLocations(' , ', rows)).deep.equals([])
  })

  it('suggests nothing until a typed word has two letters', () => {
    for (const text of ['d', 'D', 'd c', 'é', 'h, d'])
      expect(findLocations(text, rows), text).deep.equals([])
    expect(findLocations('h')).deep.equals([])
    expect(ids('de')).includes('geonames:902')
    expect(ids('d ci')).deep.equals(['geonames:902', 'geonames:901'])
  })

  describe('on the whole catalog', () => {
    const catalog = placeCatalog()
    const sample = catalog.filter((_, at) => at % 2111 === 0)
    const texts = [
      ...'abcdefghijklmnopqrstuvwxyz'
        .split('')
        .flatMap(first => [`${first}a`, `${first}o`, `s${first}`]),
      ...sample.flatMap(place => [
        place[1],
        place[1].slice(0, 3),
        `${place[1].split(' ')[0]} ${place[2].slice(0, 2)}`,
        place[2],
        `${place[2].split(' ')[0].slice(0, 4)} ${place[3]}`
      ]),
      'san d',
      'san diego',
      's diego',
      'new y',
      'calif',
      'nova sc',
      'usa',
      'united k',
      'são',
      'ca us',
      'puerto r'
    ]

    it('answers as the scan of every region and country did', function () {
      this.timeout(60_000)
      expect(texts.length).greaterThan(200)
      for (const text of texts)
        expect(findLocations(text), text).deep.equals(
          scanLocations(text, catalog)
        )
    })

    it('takes under 20 ms a search on the warm catalog', function () {
      this.timeout(30_000)
      findLocations('warm')
      for (const text of ['h', 'sa', 'san d', 'san diego'])
        expect(
          medianMs(() => findLocations(text)),
          text
        ).lessThan(20)
    })
  })

  it('ranks cities, regions and countries by match and name coverage, then population', () => {
    expect(ids('demo')).deep.equals([
      'geonames:902',
      'geonames:901',
      'region:US:Demo Region',
      'geonames:903'
    ])
    const [first] = findLocations('demo', rows)
    expect(first.location).deep.equals({
      kind: 'city',
      id: 'geonames:902',
      label: 'Demo City, Other Region',
      city: 'Demo City',
      region: 'Other Region',
      country: 'US',
      latitude: 40,
      longitude: -100
    })
    expect(first.population).equals(9000)
    const region = findLocations('demo', rows)[2]
    expect(region.location).deep.equals({
      kind: 'region',
      id: 'region:US:Demo Region',
      label: 'Demo Region',
      region: 'Demo Region',
      country: 'US'
    })
    expect(region.population).equals(5100)
  })

  it('finds a region and a country by abbreviation, and a country by name', () => {
    const ca = ids('ca')
    expect(ca).includes('region:US:California')
    expect(ca).includes('country:CA')
    expect(ids('usa')).deep.equals(['country:US'])
    expect(
      findLocations('usa', rows)[0].location.label,
      'the pill reads the abbreviation'
    ).equals('USA')
    expect(ids('united')).deep.equals(['country:US'])
    // A city found only by its region ranks below the region it is in.
    expect(ids('nova sc')).deep.equals([
      'region:CA:Nova Scotia',
      'geonames:905'
    ])
  })

  it('finds a region only by the start of its words', () => {
    const found = ids('emo')
    expect(found).not.includes('region:US:Demo Region')
    expect(found).includes('geonames:901')
  })

  it('leaves out a city with no region, and keeps at most twelve', () => {
    expect(ids('nowhere')).deep.equals([])
    const many = Array.from({ length: 20 }, (_, at) =>
      place(`8${at}`, `Testtown ${at}`, 'Demo Region', 'US', at)
    )
    expect(findLocations('testtown', many)).length(LOCATIONS_FOR_JEV)
  })

  it('writes a catalog city as its pill', () => {
    expect(cityLocation(rows[3]).label).equals('Springfield, CA')
  })

  it('reads a city pill’s coordinates, or the catalog’s', () => {
    const pill = cityLocation(rows[0])
    expect(cityCoordinates(pill, rows)).deep.equals({
      latitude: 40,
      longitude: -100
    })
    const bare = { ...pill, latitude: undefined, longitude: undefined }
    expect(cityCoordinates(bare, rows)).deep.equals({
      latitude: 40,
      longitude: -100
    })
    expect(cityCoordinates({ ...bare, id: 'geonames:1' }, rows)).equals(null)
  })

  it('spells a region and a country every way a locality may', () => {
    expect(regionSpellings('US', 'California')).deep.equals([
      'california',
      'ca'
    ])
    expect(regionSpellings('US', 'Demo Region')).deep.equals(['demo region'])
    expect(countrySpellings('US')).deep.equals(['us', 'united states', 'usa'])
    expect(countrySpellings('FR')).deep.equals(['fr', 'france'])
  })

  it('tells two pills that would read the same apart by their countries', () => {
    const twins: Place[] = [
      place('911', 'Demo City', 'Demo Region', 'US', 500),
      place('912', 'Demo City', 'Demo Region', 'PR', 400),
      place('913', 'Demo City', 'Demo Region', 'AR', 300),
      place('914', 'Demoville', 'Demo Region', 'AR', 200),
      place('915', 'Demo City', 'California', 'US', 100)
    ]
    const labels = findLocations('demo', twins).map(
      found => `${found.location.kind} ${found.location.label}`
    )
    // Each region, and each city that reads the same, adds its country; a
    // label only one pill has keeps its short form.
    expect(labels).to.include.members([
      'region Demo Region, USA',
      'region Demo Region, Puerto Rico',
      'region Demo Region, Argentina',
      'city Demo City, Demo Region, USA',
      'city Demo City, Demo Region, Puerto Rico',
      'city Demo City, Demo Region, Argentina',
      'city Demoville, Demo Region',
      'city Demo City, CA'
    ])
  })

  it('leaves a country as it is, and numbers pills still alike after their country by population', () => {
    const base = cityLocation(rows[3])
    const alike = [
      base,
      { ...base, id: 'geonames:2' },
      {
        kind: 'region' as const,
        id: 'region:SM:San Marino',
        label: 'San Marino',
        region: 'San Marino',
        country: 'SM'
      },
      {
        kind: 'country' as const,
        id: 'country:SM',
        label: 'San Marino',
        country: 'SM'
      }
    ]
    // The second Springfield is not in the catalog: it counts as smallest.
    expect(
      distinctLabels(alike, rows).map(location => location.label)
    ).deep.equals([
      'Springfield, CA, USA',
      'Springfield, CA, USA (2)',
      'San Marino, San Marino',
      'San Marino'
    ])
    expect(distinctLabels([base], rows)).deep.equals([base])
  })

  it('adds a country once however often it labels, and drops a suffix whose twin is gone', () => {
    const twins: Place[] = [
      place('921', 'Demo Falls', 'Pennsylvania', 'US', 800),
      place('922', 'Demo Falls', 'Pennsylvania', 'US', 2000),
      place('923', 'Demo Falls', 'Pennsylvania', 'US', 2000),
      place('924', 'Demo Falls', 'Demo Region', 'PR', 50)
    ]
    const pills = twins.map(cityLocation)
    const once = distinctLabels(pills, twins)
    const labels = (located: Location[]): string[] =>
      located.map(location => location.label)
    // The most populous first, ties by id, whatever order they come in.
    expect(labels(once)).deep.equals([
      'Demo Falls, PA, USA (3)',
      'Demo Falls, PA, USA',
      'Demo Falls, PA, USA (2)',
      'Demo Falls, Demo Region'
    ])
    expect(labels(distinctLabels([...once].reverse(), twins))).deep.equals(
      [...labels(once)].reverse()
    )
    // Labelled again, as Jev's answer is: nothing is added twice.
    expect(distinctLabels(once, twins)).deep.equals(once)
    // Among fewer pills, a suffix no twin calls for is gone.
    expect(labels(distinctLabels([once[1], once[3]], twins))).deep.equals([
      'Demo Falls, PA',
      'Demo Falls, Demo Region'
    ])
    expect(labels(distinctLabels([once[0], once[2]], twins))).deep.equals([
      'Demo Falls, PA, USA (2)',
      'Demo Falls, PA, USA'
    ])
  })

  it('warms rows it is given in stretches, and answers from them as a first use would', async () => {
    const given = rows.map(each => [...each] as Place)
    await warmLocations(given)
    // Nothing warms the whole catalog here: ready at once.
    await locationsReady()
    expect(findLocations('demo', given)).deep.equals(
      findLocations('demo', rows)
    )
  })

  it('warms in the background and says how it went', async () => {
    const lines: string[] = []
    warmLocationsInBackground(
      line => lines.push(line),
      async () => undefined
    )
    warmLocationsInBackground(
      line => lines.push(line),
      async () => {
        throw new Error('no catalog')
      }
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(lines).length(2)
    expect(lines[0]).match(/^search places ready in \d+ ms$/)
    expect(lines[1]).equals('search places not warmed: Error: no catalog')
  })

  it('tells the two San Juan regions apart in the catalog', () => {
    const labels = findLocations('san').map(found => found.location.label)
    expect(labels).to.include.members([
      'San Juan, Puerto Rico',
      'San Juan, Argentina'
    ])
    expect(new Set(labels).size).equals(labels.length)
  })
})
