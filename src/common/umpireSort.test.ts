import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  answeredUmpireSort,
  DEFAULT_UMPIRE_SORT,
  isUmpireSortKey,
  parseUmpireSort,
  parseUmpireSortArray,
  routeUmpireSort,
  sameUmpireSort,
  storedUmpireSort,
  UMPIRE_SORT_KEYS,
  umpireRowOrder,
  umpireSortDescending,
  umpireSortError,
  umpireSortField,
  umpireSortGlyph,
  type UmpireSortKey,
  type UmpireSortRow,
  umpireSortText
} from './umpireSort'
import { localDate } from './umpireTime'

function row(
  id: string,
  startAt: string,
  fields: Partial<UmpireSortRow> = {}
): UmpireSortRow {
  return {
    id,
    start: Date.parse(startAt),
    day: startAt.slice(0, 10),
    seasonId: 'sea_regular',
    seasonName: 'Demo Regular',
    seasonPriority: null,
    levelName: 'majors',
    ...fields
  }
}
const sorted = (
  sort: readonly UmpireSortKey[],
  rows: UmpireSortRow[]
): string[] => rows.toSorted(umpireRowOrder(sort)).map(one => one.id)

// Two seasons over two days: Fall Minors (minors, priority 1) and Demo
// Regular (majors, priority 2), a game of each on each day, Demo Regular's
// first in the day.
const fall = {
  seasonId: 'sea_fall',
  seasonName: 'Fall Minors',
  seasonPriority: 1,
  levelName: 'minors'
}
const regular = { seasonPriority: 2 }
const rows = [
  row('r1', '2027-04-03T15:00:00.000Z', regular),
  row('f1', '2027-04-03T18:00:00.000Z', fall),
  row('r2', '2027-04-04T15:00:00.000Z', regular),
  row('f2', '2027-04-04T18:00:00.000Z', fall)
]

describe('umpire sort keys', () => {
  it('names each key’s field, direction and glyphs', () => {
    expect(UMPIRE_SORT_KEYS.map(umpireSortField)).deep.equals([
      'date',
      'date',
      'season',
      'season',
      'season',
      'season',
      'certification',
      'certification'
    ])
    expect(UMPIRE_SORT_KEYS.map(umpireSortGlyph)).deep.equals([
      '19',
      '91',
      'AZ',
      'ZA',
      '19',
      '91',
      'AZ',
      'ZA'
    ])
    expect(UMPIRE_SORT_KEYS.filter(umpireSortDescending)).deep.equals([
      '-date',
      '-season',
      '-seasonPriority',
      '-certification'
    ])
    expect(isUmpireSortKey('date')).equals(true)
    expect(isUmpireSortKey('none')).equals(false)
    expect(isUmpireSortKey(7)).equals(false)
    expect(DEFAULT_UMPIRE_SORT).deep.equals(['date', 'season'])
  })

  it('reads a query’s sort strictly', () => {
    expect(parseUmpireSort('none')).deep.equals([])
    expect(parseUmpireSort('date')).deep.equals(['date'])
    expect(parseUmpireSort('-certification,seasonPriority')).deep.equals([
      '-certification',
      'seasonPriority'
    ])
    for (const bad of [
      '',
      'bogus',
      'date,bogus',
      'date,season,certification',
      'season,-seasonPriority',
      'date,-date',
      'none,date',
      'Date'
    ])
      expect(parseUmpireSort(bad), bad).equals(null)
  })

  it('reads a body’s sort strictly', () => {
    expect(parseUmpireSortArray([])).deep.equals([])
    expect(parseUmpireSortArray(['-date'])).deep.equals(['-date'])
    expect(parseUmpireSortArray(['season', 'certification'])).deep.equals([
      'season',
      'certification'
    ])
    for (const bad of [
      'none',
      ['none'],
      ['date', 'season', 'certification'],
      ['seasonPriority', 'season'],
      [7],
      null,
      { 0: 'date' }
    ])
      expect(parseUmpireSortArray(bad), JSON.stringify(bad)).equals(null)
  })

  it('reads a route’s sort leniently, keeping what is valid', () => {
    expect(routeUmpireSort(undefined)).equals(undefined)
    expect(routeUmpireSort('')).equals(undefined)
    expect(routeUmpireSort('bogus')).equals(undefined)
    expect(routeUmpireSort('none')).deep.equals([])
    expect(routeUmpireSort('bogus,season,-season,certification')).deep.equals([
      'season',
      'certification'
    ])
    expect(routeUmpireSort('date,-seasonPriority,certification')).deep.equals([
      'date',
      '-seasonPriority'
    ])
  })

  it('spells a sort and compares two', () => {
    expect(umpireSortText([])).equals('none')
    expect(umpireSortText(['-date', 'season'])).equals('-date,season')
    for (const sort of [[], ['date'], ['season', '-certification']] as const)
      expect(parseUmpireSort(umpireSortText(sort))).deep.equals(sort)
    expect(sameUmpireSort(['date'], ['date'])).equals(true)
    expect(sameUmpireSort(['date'], ['-date'])).equals(false)
    expect(sameUmpireSort(['date'], ['date', 'season'])).equals(false)
    expect(sameUmpireSort([], [])).equals(true)
  })

  it('dates a game by its calendar day in a zone', () => {
    // 23:30 in Los Angeles is the next day in New York.
    const late = Date.parse('2027-04-04T06:30:00.000Z')
    expect(localDate(late, 'America/Los_Angeles')).equals('2027-04-03')
    expect(localDate(late, 'America/New_York')).equals('2027-04-04')
    expect(localDate(new Date(late), 'America/Los_Angeles')).equals(
      '2027-04-03'
    )
  })

  it('reads an answered sort leniently, dropping keys this build lacks', () => {
    expect(answeredUmpireSort(['-date', 'seasonPriority'])).deep.equals([
      '-date',
      'seasonPriority'
    ])
    expect(answeredUmpireSort([])).deep.equals([])
    expect(answeredUmpireSort(['venue', 'season'])).deep.equals(['season'])
    expect(answeredUmpireSort(['season', '-seasonPriority', 7])).deep.equals([
      'season'
    ])
    expect(answeredUmpireSort(['venue'])).equals(undefined)
    expect(answeredUmpireSort(['none'])).equals(undefined)
  })

  it('reads a saved default as the app does: unknown keys dropped, none known or none saved is null', () => {
    expect(storedUmpireSort(['venue', 'date'])).deep.equals(['date'])
    expect(storedUmpireSort(['-certification', 'date'])).deep.equals([
      '-certification',
      'date'
    ])
    expect(storedUmpireSort([])).deep.equals([])
    expect(storedUmpireSort(['venue'])).equals(null)
    expect(storedUmpireSort(null)).equals(null)
    expect(storedUmpireSort('date')).equals(null)
  })

  it('tells a refused sort its fields, with none for a query', () => {
    expect(umpireSortError('body')).equals(
      'Choose up to two sorts of different fields: date, season, seasonPriority or certification, each with an optional leading -'
    )
    expect(umpireSortError('query')).equals(
      `${umpireSortError('body')}, or none`
    )
  })
})

describe('umpire row order', () => {
  it('sorts by each key alone, either way', () => {
    expect(sorted(['date'], rows)).deep.equals(['r1', 'f1', 'r2', 'f2'])
    expect(sorted(['-date'], rows)).deep.equals(['f2', 'r2', 'f1', 'r1'])
    expect(sorted(['season'], rows)).deep.equals(['r1', 'r2', 'f1', 'f2'])
    expect(sorted(['-season'], rows)).deep.equals(['f1', 'f2', 'r1', 'r2'])
    expect(sorted(['seasonPriority'], rows)).deep.equals([
      'f1',
      'f2',
      'r1',
      'r2'
    ])
    expect(sorted(['-seasonPriority'], rows)).deep.equals([
      'r1',
      'r2',
      'f1',
      'f2'
    ])
    expect(sorted(['certification'], rows)).deep.equals([
      'r1',
      'r2',
      'f1',
      'f2'
    ])
    expect(sorted(['-certification'], rows)).deep.equals([
      'f1',
      'f2',
      'r1',
      'r2'
    ])
    // The empty sort: date, start time and id.
    expect(sorted([], rows)).deep.equals(['r1', 'f1', 'r2', 'f2'])
  })

  it('falls back to the second field within a day, then to the time', () => {
    expect(sorted(['date', 'season'], rows)).deep.equals([
      'r1',
      'f1',
      'r2',
      'f2'
    ])
    expect(sorted(['date', '-season'], rows)).deep.equals([
      'f1',
      'r1',
      'f2',
      'r2'
    ])
    expect(sorted(['-date', 'seasonPriority'], rows)).deep.equals([
      'f2',
      'r2',
      'f1',
      'r1'
    ])
  })

  it('takes Season first with an unrelated second field, then date and time', () => {
    const third = row('r0', '2027-04-02T15:00:00.000Z', {
      ...regular,
      levelName: 'AAA'
    })
    expect(sorted(['season', 'certification'], [...rows, third])).deep.equals([
      'r0',
      'r1',
      'r2',
      'f1',
      'f2'
    ])
    expect(sorted(['-season', '-certification'], [...rows, third])).deep.equals(
      ['f1', 'f2', 'r1', 'r2', 'r0']
    )
  })

  it('reads the day in the schedule’s zone, not the instant’s UTC date', () => {
    const late = '2027-04-04T06:30:00.000Z'
    const early = '2027-04-03T20:00:00.000Z'
    const inZone = (zone: string): UmpireSortRow[] => [
      row('late', late, { ...fall, day: localDate(Date.parse(late), zone) }),
      row('early', early, {
        ...regular,
        day: localDate(Date.parse(early), zone)
      })
    ]
    // One day in Los Angeles, so Season A→Z puts Demo Regular first; two in
    // New York, so the date decides.
    expect(
      sorted(['date', 'season'], inZone('America/Los_Angeles'))
    ).deep.equals(['early', 'late'])
    expect(
      sorted(['date', '-season'], inZone('America/Los_Angeles'))
    ).deep.equals(['late', 'early'])
    expect(sorted(['date', '-season'], inZone('America/New_York'))).deep.equals(
      ['early', 'late']
    )
  })

  it('runs times newest first under Date 9→1, oldest first otherwise', () => {
    const day = [
      row('a', '2027-04-03T15:00:00.000Z'),
      row('b', '2027-04-03T18:00:00.000Z'),
      row('c', '2027-04-03T18:00:00.000Z')
    ]
    expect(sorted(['-date'], day)).deep.equals(['c', 'b', 'a'])
    expect(sorted(['season'], day)).deep.equals(['a', 'b', 'c'])
    expect(sorted(['-season'], day)).deep.equals(['a', 'b', 'c'])
  })

  it('puts seasons with no priority last both ways, by name', () => {
    const none = [
      row('z', '2027-04-03T15:00:00.000Z', {
        seasonId: 'sea_z',
        seasonName: 'Zed League',
        seasonPriority: null
      }),
      row('a', '2027-04-03T15:00:00.000Z', {
        seasonId: 'sea_a',
        seasonName: 'Alpha League',
        seasonPriority: null
      })
    ]
    expect(sorted(['seasonPriority'], [...rows, ...none])).deep.equals([
      'f1',
      'f2',
      'r1',
      'r2',
      'a',
      'z'
    ])
    expect(sorted(['-seasonPriority'], [...rows, ...none])).deep.equals([
      'r1',
      'r2',
      'f1',
      'f2',
      'a',
      'z'
    ])
    // Equal priorities fall back to the name too.
    const tied = rows.map(one => ({ ...one, seasonPriority: 1 }))
    expect(sorted(['-seasonPriority'], tied)).deep.equals([
      'r1',
      'r2',
      'f1',
      'f2'
    ])
  })

  it('orders names naturally and without case', () => {
    const named = (id: string, seasonName: string): UmpireSortRow =>
      row(id, '2027-04-03T15:00:00.000Z', { seasonId: `sea_${id}`, seasonName })
    expect(
      sorted(
        ['season'],
        [named('u10', 'U10'), named('u8', 'u8'), named('u9', 'U9 ')]
      )
    ).deep.equals(['u8', 'u9', 'u10'])
    // Equal but for case: code points decide, so the order is total.
    expect(
      sorted(['season'], [named('b', 'demo'), named('a', 'Demo')])
    ).deep.equals(['a', 'b'])
    const level = (id: string, levelName: string): UmpireSortRow =>
      row(id, '2027-04-03T15:00:00.000Z', { levelName })
    expect(
      sorted(['certification'], [level('x', 'Level 10'), level('y', 'level 2')])
    ).deep.equals(['y', 'x'])
  })

  it('keeps two seasons of one name grouped', () => {
    const twin = (
      id: string,
      seasonId: string,
      startAt: string
    ): UmpireSortRow => row(id, startAt, { seasonId, seasonName: 'Demo Twins' })
    const twins = [
      twin('a1', 'sea_a', '2027-04-03T15:00:00.000Z'),
      twin('b1', 'sea_b', '2027-04-03T16:00:00.000Z'),
      twin('a2', 'sea_a', '2027-04-03T17:00:00.000Z'),
      twin('b2', 'sea_b', '2027-04-03T18:00:00.000Z')
    ]
    expect(sorted(['season'], twins)).deep.equals(['a1', 'a2', 'b1', 'b2'])
    expect(sorted(['-season'], twins)).deep.equals(['b1', 'b2', 'a1', 'a2'])
    expect(sorted(['seasonPriority'], twins)).deep.equals([
      'a1',
      'a2',
      'b1',
      'b2'
    ])
  })

  it('breaks the last tie by id', () => {
    const same = [
      row('b', '2027-04-03T15:00:00.000Z'),
      row('a', '2027-04-03T15:00:00.000Z')
    ]
    expect(sorted(['season'], same)).deep.equals(['a', 'b'])
    expect(sorted(['-date'], same)).deep.equals(['b', 'a'])
    expect(umpireRowOrder([])(same[0], same[0])).equals(0)
  })
})
