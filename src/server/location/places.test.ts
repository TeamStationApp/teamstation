import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asLocality, localityLabel } from '../../common/locality'
import { fold } from '../../common/search/match'
import {
  coordinateColumns,
  findPlaces,
  nearestPlace,
  parseRows,
  type Place,
  placeCatalog,
  placeCoordinates,
  placesReady,
  runCooperatively,
  runNow,
  sortedBy,
  warmPlaces
} from './places'

/**
 * `findPlaces` as it was before its index, kept as what the indexed search
 * must answer: every place's folded text (Search's shared `fold`) tested for
 * every term, sorted by population, then id.
 */
function scanPlaces(query: string, rows: Place[]): string[] {
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
    .map(place => place[0])
}

const found = (query: string, rows?: Place[]): string[] =>
  findPlaces(query, rows).map(place => place.placeId ?? '')

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

const sample: Place[] = [
  ['1', 'Demo City', 'Demo Region', 'US', 20, 30, 'UTC', 1000],
  ['2', 'Demo City', 'Other Region', 'CA', 25, 35, 'UTC', 500],
  ['3', 'Cité', 'Demo Region', 'US', 20, 30, 'UTC', 200]
]
describe('public locality lookup', () => {
  it('disambiguates regions, searches accents and preserves population/id order', () => {
    expect(
      findPlaces('Demo City', sample).map(place => place.placeId)
    ).deep.equals(['1', '2'])
    expect(
      findPlaces('Demo City CA', sample).map(place => place.region)
    ).deep.equals(['Other Region'])
    expect(findPlaces('cite', sample)).length(1)
    expect(findPlaces('', sample)).length(0)
    expect(findPlaces('missing', sample)).length(0)
    expect(findPlaces('York')).not.length(0)
    // Letters NFD leaves whole fold as Search folds them: ø is o, ł is l.
    for (const [typed, city] of [
      ['tromso', 'Tromsø'],
      ['Tromsø', 'Tromsø'],
      ['lodz', 'Łódź'],
      ['ŁÓDŹ', 'Łódź']
    ])
      expect(
        findPlaces(typed).map(place => place.city),
        typed
      ).include(city)
    expect(
      findPlaces('Demo', [
        sample[0],
        ['0', 'Demo City', 'Demo Region', 'US', 20, 30, 'UTC', 1000]
      ])[0].placeId
    ).equals('0')
  })
  describe('the indexed search', () => {
    const catalog = placeCatalog()
    // Every 37th place: a slice of the catalog the old scan reads quickly.
    const slice = catalog.filter((_, at) => at % 37 === 0)
    const pick = (step: number): Place[] =>
      slice.filter((_, at) => at % step === 0)
    const queries = [
      // One character: letters, digits, folded and unfolded accents.
      ...'abcdefghijklmnopqrstuvwxyz0179'.split(''),
      ...['é', 'É', 'ł', 'ß', 'ø', "'", '-', '.', '(', 'Ω', '\u{1F600}'],
      // Two: each city's first two letters, and two from inside it.
      ...pick(97).flatMap(place => [
        place[1].slice(0, 2),
        place[1].slice(2, 4).toUpperCase()
      ]),
      // A word, the start of a word, a city with its region or country.
      ...pick(131).flatMap(place => [
        place[1],
        place[1].split(' ')[0].slice(0, 4),
        `${place[1]} ${place[2]}`,
        `${place[1].slice(0, 3)}, ${place[3]}`,
        place[2],
        `${place[2].split(' ')[0].slice(0, 3)} ${place[3].toLowerCase()}`
      ]),
      // The accented names, typed as written and folded.
      ...slice
        .filter(place => /[\u0080-\uffff]/.test(place[1]))
        .filter((_, at) => at % 23 === 0)
        .flatMap(place => [place[1], place[1].normalize('NFD')]),
      'san d',
      'san diego',
      'new york us',
      'sao paulo',
      'São Paulo',
      'zz qq',
      'xq',
      ' , ',
      'a b c',
      'ca us',
      'demo city'
    ]

    it('answers several hundred queries as the old scan did, on a slice', function () {
      this.timeout(30_000)
      expect(queries.length).greaterThan(300)
      let answered = 0
      for (const query of queries) {
        const expected = scanPlaces(query, slice)
        if (expected.length > 0) answered += 1
        expect(found(query, slice), query).deep.equals(expected)
      }
      expect(answered).greaterThan(250)
    })

    it('answers as the old scan did on the whole catalog', function () {
      this.timeout(30_000)
      for (const query of [
        'h',
        'é',
        'sa',
        'san d',
        'san diego',
        'Zürich',
        'ca us',
        'york',
        'ego',
        'xq'
      ])
        expect(found(query), query).deep.equals(scanPlaces(query, catalog))
    })

    it('still finds every character when more than its letters are seen', () => {
      // 1,100 characters, past the letters a catalog's are given one each.
      const many: Place[] = Array.from({ length: 1100 }, (_, at) => [
        String(at),
        `${String.fromCharCode(0x4e00 + at)}${String.fromCharCode(0x4e00 + ((at * 7) % 1100))}`,
        'Region',
        'US',
        0,
        0,
        'UTC',
        at % 5
      ])
      for (const query of [
        String.fromCharCode(0x4e00),
        String.fromCharCode(0x4e00 + 1090),
        String.fromCharCode(0x4e00 + 1090, 0x4e00 + ((1090 * 7) % 1100)),
        String.fromCharCode(0x4e00 + 1095, 0x4e00 + 1099),
        `${String.fromCharCode(0x4e00 + 1050)} us`
      ])
        expect(found(query, many), query).deep.equals(scanPlaces(query, many))
    })

    it('takes under 20 ms a search on the warm catalog', function () {
      this.timeout(30_000)
      found('warm')
      for (const query of ['h', 'sa', 'san d', 'san diego'])
        expect(
          medianMs(() => findPlaces(query)),
          query
        ).lessThan(20)
    })
  })

  it('suggests a locality without returning the transient coordinates', () => {
    const place = nearestPlace(20.1, 30.1, sample)
    expect(place?.placeId).equals('1')
    expect(place).not.property('latitude')
    expect(nearestPlace(0, 0, [])).equals(null)
    for (const [lat, lon] of [
      [NaN, 0],
      [91, 0],
      [0, 181]
    ])
      expect(() => nearestPlace(lat, lon, sample)).throws('invalid')
  })
  it('requires manual locality and a real timezone, retaining only allowed fields', () => {
    const city = asLocality({
      city: ' Demo ',
      region: 'Region',
      country: 'US',
      timezone: 'UTC',
      latitude: 20
    })
    expect(city).deep.equals({
      city: 'Demo',
      region: 'Region',
      country: 'US',
      timezone: 'UTC',
      placeId: null
    })
    expect(localityLabel(city)).equals('Demo, Region, US')
    expect(localityLabel(null)).equals('Location not set')
    expect(asLocality({ ...city, placeId: '1' }).placeId).equals('1')
    for (const raw of [
      null,
      [],
      {},
      { ...city, timezone: 'Not/A_Timezone' },
      { ...city, city: '' },
      { ...city, region: 'a'.repeat(121) }
    ])
      expect(() => asLocality(raw)).throws(TypeError)
  })
  describe('placeCoordinates', () => {
    const rows: Place[] = [
      ['11', 'Demo City', 'California', 'US', 32.7, -117.1, 'UTC', 900],
      ['12', 'Demo City', 'California', 'US', 33.1, -117.4, 'UTC', 100],
      ['13', 'Demo City', 'Texas', 'US', 27.7, -98.2, 'UTC', 5000],
      ['14', 'Démo Town', 'Ontario', 'CA', 43.6, -79.3, 'UTC', 50],
      ['15', 'Demo Port', 'Demo Shire', 'GB', 51.5, -0.1, 'UTC', 70],
      ['16', 'Demo Port', 'Demo Shire', 'GB', 52.5, -1.1, 'UTC', 70],
      ['17', 'Demo Bay', 'Demo Coast', 'NZ', -36.8, 174.7, 'UTC', 80]
    ]
    const at = (
      city: string,
      region: string,
      country: string,
      placeId: string | null = null
    ): ReturnType<typeof placeCoordinates> =>
      placeCoordinates(
        { city, region, country, placeId, timezone: 'UTC' },
        rows
      )
    it('maps a GeoNames place id, prefixed or bare, to its own city', () => {
      expect(at('Anything', 'Else', 'US', 'geonames:12')).deep.equals({
        latitude: 33.1,
        longitude: -117.4
      })
      expect(at('Anything', 'Else', 'US', '12')).deep.equals({
        latitude: 33.1,
        longitude: -117.4
      })
    })
    it('takes the most populous city of the same city, region and country otherwise', () => {
      const sanDiego = { latitude: 32.7, longitude: -117.1 }
      // A Google id never names a catalog row.
      expect(at('Demo City', 'California', 'US', 'google:abc')).deep.equals(
        sanDiego
      )
      expect(at(' demo city ', 'CALIFORNIA', 'us')).deep.equals(sanDiego)
      // Google writes the country's name; a person may write its abbreviation.
      expect(at('Demo City', 'California', 'United States')).deep.equals(
        sanDiego
      )
      expect(at('Demo City', 'CA', 'USA')).deep.equals(sanDiego)
      expect(at('Demo City', 'Texas', 'US')).deep.equals({
        latitude: 27.7,
        longitude: -98.2
      })
      // A GeoNames id the catalog no longer has falls back to the names.
      expect(at('Demo City', 'Texas', 'US', 'geonames:999')).deep.equals({
        latitude: 27.7,
        longitude: -98.2
      })
      expect(at('Demo Town', 'ON', 'Canada')).deep.equals({
        latitude: 43.6,
        longitude: -79.3
      })
      expect(at('Demo Port', 'Demo Shire', 'United Kingdom')).deep.equals({
        latitude: 51.5,
        longitude: -0.1
      })
      expect(at('Demo Port', 'Demo Shire', 'UK')).deep.equals({
        latitude: 51.5,
        longitude: -0.1
      })
      expect(at('Demo Bay', 'Demo Coast', 'New Zealand')).deep.equals({
        latitude: -36.8,
        longitude: 174.7
      })
      // A city written without its ø or ł is the catalog's own.
      expect(
        placeCoordinates({
          city: 'Tromso',
          region: 'Troms',
          country: 'NO',
          placeId: null,
          timezone: 'Europe/Oslo'
        })
      ).deep.equals({ latitude: 69.6489, longitude: 18.95508 })
      expect(
        placeCoordinates({
          city: 'Lodz',
          region: 'Łódź Voivodeship',
          country: 'PL',
          placeId: null,
          timezone: 'Europe/Warsaw'
        })
      ).deep.equals({ latitude: 51.77058, longitude: 19.47395 })
    })
    it('has none for a city the catalog does not hold', () => {
      expect(at('Nowhere', 'California', 'US')).equals(null)
      expect(at('Demo City', 'Ontario', 'US')).equals(null)
      expect(at('Demo City', 'California', 'CA')).equals(null)
      expect(at('Demo Bay', 'Demo Coast', 'NZL')).equals(null)
      expect(placeCoordinates(null, rows)).equals(null)
      expect(placeCoordinates(undefined)).equals(null)
    })
    it('writes the columns from the shipped catalog, nulls for none', () => {
      expect(
        coordinateColumns({
          city: 'San Diego',
          region: 'California',
          country: 'US',
          placeId: null,
          timezone: 'America/Los_Angeles'
        })
      ).deep.equals({ latitude: 32.71571, longitude: -117.16472 })
      expect(
        coordinateColumns({
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        })
      ).deep.equals({ latitude: null, longitude: null })
      expect(coordinateColumns(null)).deep.equals({
        latitude: null,
        longitude: null
      })
    })
  })
})

describe('the cooperative place build', () => {
  const row = (id: string, city: string): Place => [
    id,
    city,
    'Demo Region',
    'US',
    40,
    -100,
    'UTC',
    Number(id)
  ]

  it('reads the catalog’s rows a run at a time, as JSON.parse reads them whole', () => {
    const rows = Array.from({ length: 4500 }, (_, at) =>
      row(String(at), `Demo ${at}`)
    )
    // Names that hold the cut between rows, and one that ends a run.
    rows[1999][1] = 'Odd],["Town'
    rows[2000][1] = '],['
    rows[4499][1] = 'Last ],[ Town'
    const text = JSON.stringify(rows)
    expect(runNow(parseRows(text))).deep.equals(rows)
    expect(
      runNow(parseRows(` [ ${JSON.stringify(rows.slice(0, 3)).slice(1)}`))
    ).deep.equals(rows.slice(0, 3))
    expect(runNow(parseRows('[]'))).deep.equals([])
    expect(runNow(parseRows('[ ]'))).deep.equals([])
    expect(() => runNow(parseRows('nothing'))).throws(SyntaxError)
    expect(() => runNow(parseRows('[["1",],["2"]]'))).throws(SyntaxError)
  })

  it('sorts as a stable sort does, a run at a time', () => {
    const items = Array.from({ length: 5000 }, (_, at) => ({
      at,
      key: (at * 7919) % 97
    }))
    const compare = (a: { key: number }, b: { key: number }): number =>
      a.key - b.key
    expect(runNow(sortedBy(items, compare))).deep.equals(
      [...items].sort(compare)
    )
    expect(runNow(sortedBy([3, 1, 2], (a, b) => a - b))).deep.equals([1, 2, 3])
    expect(runNow(sortedBy([], (a, b) => a - b))).deep.equals([])
  })

  it('gives the event loop a turn between stretches', async () => {
    let turns = 0
    const ticking = setInterval(() => {
      turns++
    }, 0)
    function* slow(): Generator<void, string, void> {
      for (let at = 0; at < 5; ++at) {
        const until = Date.now() + 3
        while (Date.now() < until);
        yield
      }
      return 'done'
    }
    try {
      expect(await runCooperatively(slow(), 1)).equals('done')
    } finally {
      clearInterval(ticking)
    }
    expect(turns).greaterThan(0)
  })

  it('warms rows it is given, and finds in them what a first use would', async () => {
    const rows = [
      row('7', 'Demo Falls'),
      row('9', 'Demo Falls'),
      row('8', 'Elsewhere')
    ]
    const copy = rows.map(place => [...place] as Place)
    await warmPlaces(rows)
    await placesReady()
    expect(found('falls', rows)).deep.equals(found('falls', copy))
    expect(found('falls', rows)).deep.equals(['9', '7'])
  })
})
