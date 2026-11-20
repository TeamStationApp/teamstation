import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfValue } from '../userId'
import {
  askOfFrame,
  asLocation,
  asSearchFrame,
  asSearchResult,
  asSearchServerFrame,
  asSeq,
  cityLocationId,
  countryLocationId,
  type Location,
  regionLocationId,
  SEARCH_ERROR_CODES,
  SEARCH_FRAME_MAX_BYTES,
  SEARCH_RESULTS_MAX,
  SEARCH_SOCKET_PATH,
  SEARCH_TEXT_MAX,
  searchServerFrameOf
} from './types'

const city: Location = {
  kind: 'city',
  id: cityLocationId('5391811'),
  label: 'San Diego, CA',
  city: 'San Diego',
  region: 'California',
  country: 'US',
  latitude: 32.72,
  longitude: -117.16
}
const region: Location = {
  kind: 'region',
  id: regionLocationId('US', 'California'),
  label: 'California',
  region: 'California',
  country: 'US'
}
const country: Location = {
  kind: 'country',
  id: countryLocationId('US'),
  label: 'USA',
  country: 'US'
}
const userId = userIdOfValue(1n)

describe('search socket constants', function () {
  it('names the path and limits', function () {
    expect(SEARCH_SOCKET_PATH).equals('/api/v1/search')
    expect(SEARCH_FRAME_MAX_BYTES).equals(4096)
    expect(SEARCH_TEXT_MAX).equals(200)
  })
})

describe('location ids', function () {
  it('writes each kind', function () {
    expect(cityLocationId('1')).equals('geonames:1')
    expect(regionLocationId('CA', 'Ontario')).equals('region:CA:Ontario')
    expect(countryLocationId('GB')).equals('country:GB')
  })
})

describe('asSeq', function () {
  it('takes non-negative integers only', function () {
    expect(asSeq(0)).equals(0)
    expect(asSeq(41)).equals(41)
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 60, '1'])
      expect(() => asSeq(bad)).throws(TypeError)
  })
})

describe('asLocation', function () {
  it('keeps each kind and drops unknown keys', function () {
    expect(asLocation({ ...city, extra: 1 })).deep.equals(city)
    expect(asLocation(region)).deep.equals(region)
    expect(asLocation(country)).deep.equals(country)
  })

  it('refuses a bad shape', function () {
    for (const bad of [
      null,
      'city',
      { ...city, kind: 'street' },
      { ...city, label: '  ' },
      { ...city, label: 'x'.repeat(301) },
      { ...city, country: 'usa' },
      { ...city, country: 'us' },
      { ...city, latitude: 91 },
      { ...city, longitude: -181 },
      { ...city, latitude: Number.POSITIVE_INFINITY },
      { ...city, latitude: undefined },
      { ...city, longitude: undefined }
    ])
      expect(() => asLocation(bad)).throws(TypeError)
  })

  it('needs a city its city, region and geonames: id', function () {
    expect(() => asLocation({ ...city, city: undefined })).throws(
      /city and region/
    )
    expect(() => asLocation({ ...city, region: undefined })).throws(
      /city and region/
    )
    expect(() => asLocation({ ...city, id: 'region:US:California' })).throws(
      /geonames/
    )
    expect(() => asLocation({ ...city, id: 'geonames:' })).throws(/geonames/)
  })

  it('needs a region its region and region: id', function () {
    expect(() => asLocation({ ...region, region: undefined })).throws(
      /with its region/
    )
    expect(() =>
      asLocation({ ...region, id: regionLocationId('US', 'Texas') })
    ).throws(/region: id/)
  })

  it('needs a country its country: id', function () {
    expect(() => asLocation({ ...country, id: 'country:CA' })).throws(
      /country: id/
    )
  })

  it('keeps a location with no coordinates', function () {
    const bare = { ...city }
    delete bare.latitude
    delete bare.longitude
    expect(asLocation(bare)).deep.equals(bare)
  })
})

describe('asSearchResult', function () {
  const team = {
    kind: 'team',
    id: 'tem_demo',
    name: 'Demo Hawks',
    imageUrl: null,
    cityLine: 'Demo City, CA',
    associations: 'Demo League A',
    follow: 'follow'
  }
  const person = {
    kind: 'person',
    userId,
    name: 'Mookie B',
    avatarUrl: 'https://media.example.test/a.png',
    associations: 'Demo Hawks'
  }

  it('reads groups and people', function () {
    expect(asSearchResult(team)).deep.equals(team)
    expect(
      asSearchResult({ ...team, kind: 'league', cityLine: null, follow: null })
    ).deep.equals({ ...team, kind: 'league', cityLine: null, follow: null })
    expect(
      asSearchResult({ ...team, kind: 'season', follow: 'following' })
    ).deep.equals({ ...team, kind: 'season', follow: 'following' })
    expect(asSearchResult(person)).deep.equals(person)
    expect(asSearchResult({ ...person, avatarUrl: null })).deep.equals({
      ...person,
      avatarUrl: null
    })
  })

  it('refuses a bad row', function () {
    for (const bad of [
      null,
      { ...team, kind: 'venue' },
      { ...team, follow: 'yes' },
      { ...team, id: '' },
      { ...team, imageUrl: undefined },
      { ...person, userId: 'usr_1' },
      { ...person, associations: undefined }
    ])
      expect(() => asSearchResult(bad)).throws(TypeError)
  })

  it('reads Add Existing Player’s card on a person, with its optional formats only when present', function () {
    expect(SEARCH_RESULTS_MAX).equals(50)
    const roster = {
      gumboId: 12,
      shortName: 'Mookie B',
      shortParts: { first: 'Mookie', last: 'B' },
      bats: 'right',
      throws: 'right',
      teams: [{ teamId: 'tem_demo', name: 'Demo Hawks' }],
      tier: 'mine'
    }
    expect(asSearchResult({ ...person, roster })).deep.equals({
      ...person,
      roster
    })
    const formatted = {
      ...roster,
      gumboId: null,
      nameFormat: 'initials',
      compactName: 'M B',
      compactFormat: 'initialLast',
      bats: null,
      throws: null,
      tier: 'league'
    }
    expect(
      asSearchResult({ ...person, roster: { ...formatted, extra: 1 } })
    ).deep.equals({ ...person, roster: formatted })
    for (const bad of [
      { ...roster, tier: 'stranger' },
      { ...roster, nameFormat: 'nickname' },
      { ...roster, teams: [{ teamId: '', name: 'Demo Hawks' }] }
    ])
      expect(() => asSearchResult({ ...person, roster: bad })).throws(TypeError)
  })
})

describe('asSearchFrame', function () {
  const frame = {
    type: 'search',
    seq: 3,
    text: 'demo hawks',
    location: null,
    mode: 'all'
  }

  it('reads a search for everything', function () {
    expect(asSearchFrame(frame)).deep.equals(frame)
    expect(asSearchFrame({ ...frame, text: '', location: city })).deep.equals({
      ...frame,
      text: '',
      location: city
    })
  })

  it('reads a people search for a team and a game', function () {
    const people = {
      ...frame,
      mode: 'people',
      forTeam: 'tem_demo',
      forGame: 'gam_demo'
    }
    expect(asSearchFrame(people)).deep.equals(people)
    const teamOnly = { ...frame, mode: 'people', forTeam: 'tem_demo' }
    expect(asSearchFrame(teamOnly)).deep.equals(teamOnly)
    expect(asSearchFrame({ ...frame, mode: 'people' })).deep.equals({
      ...frame,
      mode: 'people'
    })
  })

  it('refuses a bad frame', function () {
    for (const bad of [
      null,
      { ...frame, type: 'results' },
      { ...frame, seq: -1 },
      { ...frame, text: 'x'.repeat(201) },
      { ...frame, location: undefined },
      { ...frame, location: { ...city, kind: 'street' } },
      { ...frame, mode: 'teams' },
      { ...frame, mode: 'people', forTeam: '' }
    ])
      expect(() => asSearchFrame(bad)).throws(TypeError)
    expect(() =>
      asSearchFrame({ ...frame, text: 'x'.repeat(200) })
    ).not.throws()
  })

  it('takes forTeam only in mode people, and forGame only with it', function () {
    expect(() => asSearchFrame({ ...frame, forTeam: 'tem_demo' })).throws(
      /mode people/
    )
    expect(() =>
      asSearchFrame({ ...frame, mode: 'people', forGame: 'gam_demo' })
    ).throws(/with forTeam/)
  })
})

describe('askOfFrame', function () {
  it('keeps the ask and drops the envelope', function () {
    expect(
      askOfFrame({
        type: 'search',
        seq: 1,
        text: 'demo',
        location: region,
        mode: 'all'
      })
    ).deep.equals({ text: 'demo', location: region, mode: 'all' })
    expect(
      askOfFrame({
        type: 'search',
        seq: 2,
        text: 'mookie',
        location: null,
        mode: 'people',
        forTeam: 'tem_demo',
        forGame: 'gam_demo'
      })
    ).deep.equals({
      text: 'mookie',
      location: null,
      mode: 'people',
      forTeam: 'tem_demo',
      forGame: 'gam_demo'
    })
  })
})

describe('asSearchServerFrame', function () {
  const results = {
    type: 'results',
    seq: 4,
    stage: 'lexicographic',
    results: [
      {
        kind: 'person',
        userId,
        name: 'Mookie B',
        avatarUrl: null,
        associations: ''
      }
    ],
    locations: [city, region, country]
  }

  it('reads results at both stages', function () {
    expect(asSearchServerFrame(results)).deep.equals(results)
    expect(asSearchServerFrame({ ...results, stage: 'jev' })).deep.equals({
      ...results,
      stage: 'jev'
    })
  })

  it('reads errors with and without a seq', function () {
    const error = {
      type: 'error',
      seq: 4,
      code: 'malformed',
      message: 'Expected a search frame'
    }
    expect(asSearchServerFrame(error)).deep.equals(error)
    const { seq: _seq, ...unnumbered } = error
    for (const code of SEARCH_ERROR_CODES)
      expect(asSearchServerFrame({ ...unnumbered, code })).deep.equals({
        ...unnumbered,
        code
      })
  })

  it('refuses a bad frame', function () {
    for (const bad of [
      null,
      { type: 'hello' },
      { ...results, stage: 'model' },
      { ...results, results: [{ kind: 'venue' }] },
      { ...results, locations: [{ kind: 'city' }] },
      { type: 'error', code: 'nope', message: '' },
      { type: 'error', code: 'internal', message: 'x'.repeat(301) }
    ])
      expect(() => asSearchServerFrame(bad)).throws(TypeError)
  })
})

describe('searchServerFrameOf', function () {
  const person = {
    kind: 'person',
    userId,
    name: 'Mookie B',
    avatarUrl: null,
    associations: ''
  }
  const frame = {
    type: 'results',
    seq: 4,
    stage: 'jev',
    results: [person],
    locations: [city]
  }

  it('reads a whole frame as asSearchServerFrame does, dropping nothing', function () {
    const dropped: unknown[] = []
    expect(searchServerFrameOf(frame, row => dropped.push(row))).deep.equals(
      frame
    )
    const error = { type: 'error', code: 'internal', message: 'Oops' }
    expect(searchServerFrameOf(error, row => dropped.push(row))).deep.equals(
      error
    )
    expect(dropped).deep.equals([])
  })

  it('leaves out only the rows it cannot read, and says which', function () {
    const dropped: Array<{ list: string; index: number }> = []
    const read = searchServerFrameOf(
      {
        ...frame,
        results: [
          { ...person, associations: 'x'.repeat(2000) },
          person,
          { kind: 'venue' }
        ],
        locations: [{ kind: 'city' }, city]
      },
      ({ list, index, error }) => {
        expect(error).instanceOf(TypeError)
        dropped.push({ list, index })
      }
    )
    expect(read).deep.equals(frame)
    expect(dropped).deep.equals([
      { list: 'results', index: 0 },
      { list: 'results', index: 2 },
      { list: 'locations', index: 0 }
    ])
  })

  it('refuses a frame whose own fields are wrong', function () {
    for (const bad of [
      null,
      { ...frame, seq: -1 },
      { ...frame, stage: 'model' },
      { ...frame, results: 'none' },
      { type: 'error', code: 'nope', message: '' }
    ])
      expect(() => searchServerFrameOf(bad, () => undefined)).throws(TypeError)
  })
})
