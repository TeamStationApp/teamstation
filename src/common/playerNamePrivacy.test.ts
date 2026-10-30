import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asPlayerNamePrivacy,
  asStoredPlayerNamePrivacy,
  mostRestrictive,
  PLAYER_NAME_PRIVACY_LABELS,
  PLAYER_NAME_PRIVACY_STOPS,
  type PlayerNamePrivacy,
  type PlayerNamePrivacySource,
  resolvePlayerNamePrivacy,
  spokenFormat
} from './playerNamePrivacy'

const source = (
  kind: PlayerNamePrivacySource['kind'],
  id: string,
  value: PlayerNamePrivacy | null,
  name = id
): PlayerNamePrivacySource => ({ kind, id, name, value })

const team = (value: PlayerNamePrivacy | null): PlayerNamePrivacySource =>
  source('team', 'hawks', value)

describe('player name privacy values', function () {
  it('offers Default first, then the four formats', function () {
    expect(PLAYER_NAME_PRIVACY_STOPS).deep.equals([
      null,
      'firstLastInitial',
      'initialLast',
      'initials',
      'full'
    ])
    expect(PLAYER_NAME_PRIVACY_LABELS.initialLast).equals(
      'First initial, last name'
    )
  })

  it('refuses an unknown token and reads a bad stored one as Default', function () {
    expect(() => asPlayerNamePrivacy('everything')).throws()
    expect(asStoredPlayerNamePrivacy('initials')).equals('initials')
    expect(asStoredPlayerNamePrivacy('everything')).equals(null)
  })

  it('orders restrictiveness with the surname treated as wider', function () {
    expect(mostRestrictive(['full', 'initialLast'])).equals('initialLast')
    expect(mostRestrictive(['initialLast', 'firstLastInitial'])).equals(
      'firstLastInitial'
    )
    expect(mostRestrictive(['firstLastInitial', 'initials'])).equals('initials')
    expect(mostRestrictive([])).equals('firstLastInitial')
  })

  it('never speaks a surname or a withheld first name', function () {
    expect(spokenFormat('full')).equals('firstLastInitial')
    expect(spokenFormat('firstLastInitial')).equals('firstLastInitial')
    expect(spokenFormat('initialLast')).equals('initials')
    expect(spokenFormat('initials')).equals('initials')
  })
})

describe('resolving player name privacy', function () {
  it('is the built-in format with nothing set anywhere', function () {
    for (const kind of ['league', 'season', 'team'] as const)
      expect(
        resolvePlayerNamePrivacy({
          self: source(kind, 'x', null),
          managingSeasons: [],
          managingLeagues: []
        })
      ).deep.equals({
        format: 'firstLastInitial',
        stored: null,
        inheritedFrom: []
      })
  })

  it('lets an explicit built-in format replace a season', function () {
    expect(
      resolvePlayerNamePrivacy({
        self: team('firstLastInitial'),
        managingSeasons: [source('season', 'spring', 'full')],
        managingLeagues: []
      })
    ).deep.equals({
      format: 'firstLastInitial',
      stored: 'firstLastInitial',
      inheritedFrom: []
    })
  })

  it('takes the more restrictive of two managing seasons', function () {
    const resolved = resolvePlayerNamePrivacy({
      self: team(null),
      managingSeasons: [
        source('season', 'one', 'full', 'Season 1'),
        source('season', 'two', 'firstLastInitial', 'Season 2')
      ],
      managingLeagues: []
    })
    expect(resolved.format).equals('firstLastInitial')
    expect(resolved.inheritedFrom.map(from => from.name)).deep.equals([
      'Season 2'
    ])
  })

  it('takes a league through a season left on Default', function () {
    const resolved = resolvePlayerNamePrivacy({
      self: team(null),
      managingSeasons: [source('season', 'spring', null)],
      managingLeagues: [source('league', 'lakeshore', 'full', 'Lakeshore')]
    })
    expect(resolved.format).equals('full')
    expect(resolved.inheritedFrom).deep.equals([
      { kind: 'league', id: 'lakeshore', name: 'Lakeshore' }
    ])
  })

  it('lets a season replace a stricter league', function () {
    const resolved = resolvePlayerNamePrivacy({
      self: team(null),
      managingSeasons: [source('season', 'spring', 'full', 'Spring')],
      managingLeagues: [source('league', 'lakeshore', 'initials')]
    })
    expect(resolved.format).equals('full')
    expect(resolved.inheritedFrom.map(from => from.name)).deep.equals([
      'Spring'
    ])
  })

  it('names both of two tied seasons, by name then id', function () {
    const resolved = resolvePlayerNamePrivacy({
      self: team(null),
      managingSeasons: [
        source('season', 'b', 'initials', 'Fall'),
        source('season', 'c', 'initials', 'Spring'),
        source('season', 'a', 'initials', 'Fall'),
        source('season', 'd', null, 'Winter')
      ],
      managingLeagues: []
    })
    expect(resolved.inheritedFrom.map(from => from.id)).deep.equals([
      'a',
      'b',
      'c'
    ])
  })

  it('takes the more restrictive of two leagues', function () {
    const resolved = resolvePlayerNamePrivacy({
      self: team(null),
      managingSeasons: [source('season', 'spring', null)],
      managingLeagues: [
        source('league', 'one', 'full'),
        source('league', 'two', 'initialLast'),
        source('league', 'three', null)
      ]
    })
    expect(resolved.format).equals('initialLast')
    expect(resolved.inheritedFrom.map(from => from.id)).deep.equals(['two'])
  })

  it('resolves a season from its league', function () {
    expect(
      resolvePlayerNamePrivacy({
        self: source('season', 'spring', null),
        managingSeasons: [],
        managingLeagues: [source('league', 'lakeshore', 'initials')]
      }).format
    ).equals('initials')
  })
})
