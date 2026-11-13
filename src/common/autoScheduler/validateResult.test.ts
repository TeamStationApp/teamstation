import { expect } from 'chai'
import { describe, it } from 'mocha'

import { wallInstant } from '../fieldAvailability'
import { asPreviewResult } from '../schedulePreviews'
import {
  buildContext,
  fullContextBytes,
  MAX_FIELD_DAYS,
  requireBoundedFieldDays
} from './context'
import { field, fixedGame, hoursOn, input, season, ZONE } from './fixtures.test'
import { buildOptions } from './index'
import { summarizeResult } from './validateResult'

describe('device result summaries', () => {
  it('preserves midseason scores and comparison reasons when earlier games are fixed', () => {
    const run = input({
      notBefore: Date.parse('2027-06-01T00:00:00Z'),
      seasons: [season({ regularGames: 6, exhibitionGames: 0 })],
      fixed: [
        fixedGame('played', 'tem_hawks', 'tem_owls', '2027-03-06T16:00:00Z')
      ]
    })
    const built = buildOptions(run)
    const summary = summarizeResult(run, asPreviewResult(built))
    expect(
      summary.options.map(option => ({
        score: option.score,
        reasons: option.reasons,
        fairness: option.fairness
      }))
    ).deep.equals(
      built.options.map(option => ({
        score: option.score,
        reasons: option.reasons,
        fairness: option.fairness
      }))
    )
  })
  it('summarizes only proposed slots without allocating search availability', () => {
    const run = input({
      seasons: [season({ regularGames: 1, exhibitionGames: 0 })]
    })
    const built = buildOptions(run)
    const games = built.options[0].games
    const search = buildContext(run)
    const summary = buildContext(run, games)
    expect(search.seasons[0].slots.length).greaterThan(games.length)
    expect(summary.seasons[0].slots).has.length(games.length)
    expect(summary.seasons[0].teamFree.size).equals(0)
    expect(summary.seasons[0].supply).deep.equals(search.seasons[0].supply)
    expect(
      summarizeResult(run, asPreviewResult(built)).options.map(
        option => option.fairness
      )
    ).deep.equals(built.options.map(option => option.fairness))
    for (const changed of [
      { fieldId: 'foreign' },
      { endAt: games[0].startAt },
      {
        startAt: new Date(Date.parse(games[0].startAt) + 60000).toISOString(),
        endAt: new Date(Date.parse(games[0].endAt) + 60000).toISOString()
      }
    ])
      expect(() =>
        summarizeResult(run, {
          blocking: null,
          options: [
            { ...built.options[0], games: [{ ...games[0], ...changed }] }
          ]
        })
      ).throws('time windows')
  })
  it('rejects unbounded calendar work before enumerating even an empty option', () => {
    const run = input({
      seasons: [season({ startsOn: '0001-01-01', endsOn: '9999-12-31' })]
    })
    expect(() =>
      summarizeResult(run, {
        blocking: null,
        options: [
          { games: [], fairness: [], reasons: [], unmet: [], score: [] }
        ]
      })
    ).throws('too many field days')
  })
  it('counts only the days a time window has hours on toward the field-day limit', () => {
    const fields = Array.from({ length: 120 }, (_, i) =>
      field({ id: `fld_${i}` })
    )
    const yearOf = (weekdays: number[]): ReturnType<typeof season> =>
      season({
        regularGames: 0,
        exhibitionGames: 0,
        fieldIds: fields.map(each => each.id),
        startsOn: '2027-01-01',
        endsOn: '2027-12-31',
        windows: [
          {
            from: '2027-01-01',
            until: '2027-12-31',
            hours: hoursOn(weekdays, '08:00', '18:00')
          }
        ]
      })
    const bounded = (each: ReturnType<typeof season>): void => {
      requireBoundedFieldDays(input({ seasons: [each], fields }))
    }
    // 52 Saturdays on 120 fields fit; the same year every day does not.
    expect(() => {
      bounded(yearOf([6]))
    }).not.throws()
    expect(() => {
      bounded(yearOf([0, 1, 2, 3, 4, 5, 6]))
    }).throws('shorter time windows')
  })
  it('allows three seasons sharing 20 fields every day for six months, as servers built before', () => {
    const fields = Array.from({ length: 20 }, (_, i) =>
      field({ id: `fld_${i}` })
    )
    const daily = hoursOn([0, 1, 2, 3, 4, 5, 6], '08:00', '20:00')
    const seasons = ['a', 'b', 'c'].map(id =>
      season(
        {
          fieldIds: fields.map(each => each.id),
          startsOn: '2027-03-01',
          endsOn: '2027-08-27',
          windows: [{ from: '2027-03-01', until: '2027-08-27', hours: daily }]
        },
        { id: `sea_${id}` }
      )
    )
    expect(() => {
      requireBoundedFieldDays(input({ seasons, fields }))
    }).not.throws()
    expect(MAX_FIELD_DAYS).greaterThan(3 * 20 * 180)
  })
  it('names a plain cause for a shortfall when a full context would not fit the worker', () => {
    const fields = Array.from({ length: 28 }, (_, i) =>
      field({
        id: `fld_${i}`,
        availability: {
          ...field().availability,
          hours: hoursOn([6], '00:00', '23:55')
        }
      })
    )
    const run = input({
      seasons: [
        season({
          regularGames: 2,
          exhibitionGames: 0,
          fieldIds: fields.map(each => each.id),
          startsOn: '2027-01-01',
          endsOn: '2027-12-31',
          windows: [
            {
              from: '2027-01-01',
              until: '2027-12-31',
              hours: hoursOn([6], '00:00', '23:55')
            }
          ]
        })
      ],
      fields
    })
    expect(fullContextBytes(run)).greaterThan(64 * 1024 * 1024)
    const empty = { games: [], fairness: [], reasons: [], unmet: [], score: [] }
    const [option] = summarizeResult(run, {
      options: [empty],
      blocking: null
    }).options
    expect(option.unmet).has.length(1)
    expect(option.unmet[0].cause).equals(
      'The selected fields, time windows and constraints leave too little room for these games.'
    )
  })
  it('derives fairness from placements and rejects games outside time windows', () => {
    const run = input({
      seasons: [season({ regularGames: 1, exhibitionGames: 0 })]
    })
    const result = buildOptions(run)
    const clean = asPreviewResult(result)
    const summary = summarizeResult(run, clean)
    expect(summary.options[0].fairness).deep.equals(result.options[0].fairness)
    expect(summary.options[0].reasons).deep.equals([])
    clean.options[0].games[0].startAt = '2027-01-01T00:00:00Z'
    expect(() => summarizeResult(run, clean)).throws('time windows')
  })
  it('derives missing requests, fixed-game counts and alternative summaries', () => {
    const run = input({
      seasons: [season({ regularGames: 1, exhibitionGames: 0 })]
    })
    const built = buildOptions(run)
    const game = built.options[0].games[0]
    const empty = { games: [], fairness: [], reasons: [], unmet: [], score: [] }
    expect(
      summarizeResult(run, { options: [empty, empty], blocking: null })
        .options[0].unmet
    ).has.length.greaterThan(0)
    run.required = [{ ...game }]
    expect(
      summarizeResult(run, { options: [empty], blocking: null }).options[0]
        .unmet[0].message
    ).equals('1 of the 1 game to place again couldn’t be placed')
    expect(
      summarizeResult(run, {
        options: [{ ...empty, games: [game] }],
        blocking: null
      }).options[0].unmet
    ).deep.equals([])
    run.fixed = [
      { ...game, start: Date.parse(game.startAt), end: Date.parse(game.endAt) }
    ]
    run.required = []
    expect(
      summarizeResult(run, { options: [empty], blocking: null }).options[0]
        .unmet
    ).deep.equals([])
  })
  it('reports no exhibition shortfall when the season has no exhibition teams', () => {
    const run = input({
      seasons: [
        season({ regularGames: 2, exhibitionGames: 1 }, { exhibitionTeams: [] })
      ]
    })
    const built = buildOptions(run)
    expect(built.options[0].unmet).deep.equals([])
    expect(
      summarizeResult(run, asPreviewResult(built)).options.map(
        option => option.unmet
      )
    ).deep.equals(built.options.map(option => option.unmet))
  })
  it('reports a field-time shortfall with the engine’s totals and cause', () => {
    const run = input({
      seasons: [
        season({ regularGames: 4, exhibitionGames: 0, endsOn: '2027-03-03' })
      ]
    })
    const built = buildOptions(run)
    expect(built.options[0].unmet).has.length.greaterThan(0)
    expect(
      summarizeResult(run, asPreviewResult(built)).options.map(
        option => option.unmet
      )
    ).deep.equals(built.options.map(option => option.unmet))
  })
  it('scores and explains an option that leaves more games unplaced', () => {
    const run = input({
      seasons: [season({ regularGames: 2, exhibitionGames: 0 })]
    })
    const [best] = asPreviewResult(buildOptions(run)).options
    const fewer = { ...best, games: best.games.slice(1) }
    const summary = summarizeResult(run, {
      options: [best, fewer],
      blocking: null
    })
    expect(summary.options[0].unmet).deep.equals([])
    expect(summary.options[1].unmet).has.length(1)
    expect(summary.options[1].reasons[0]).equals('1 more game left unplaced')
  })
  it('names the engine’s manager and field-time causes for a shortfall', () => {
    const saturdays = hoursOn([6], '08:00', '18:00')
    const run = input({
      seasons: [
        season({
          regularGames: 3,
          exhibitionGames: 0,
          doubleheaders: 'never',
          endsOn: '2027-03-31',
          windows: [{ from: '2027-03-01', hours: saturdays }]
        })
      ],
      fields: [
        field({ availability: { ...field().availability, hours: saturdays } })
      ]
    })
    const [home, away] = run.seasons[0].participants
    run.seasons[0].participants = [home, away]
    run.headCoaches = { [home]: 'coach', outside: 'coach' }
    run.bookings = ['2027-03-06', '2027-03-13', '2027-03-20'].map(day => ({
      key: `bkg_${day}`,
      fieldId: null,
      size: null,
      teamIds: ['outside'],
      start: wallInstant(day, '07:00', ZONE),
      end: wallInstant(day, '19:00', ZONE)
    }))
    const summaryOf = (each: typeof run): unknown[] =>
      summarizeResult(each, asPreviewResult(buildOptions(each))).options.map(
        option => option.unmet
      )
    const built = buildOptions(run)
    expect(built.options[0].unmet[0].cause).includes('Manager/Head Coach')
    expect(summaryOf(run)).deep.equals(built.options.map(o => o.unmet))
    // A weekly maximum that does not bind: field time is the cause, as the
    // engine reports it, not the maximum.
    const weekly = {
      ...run,
      headCoaches: undefined,
      bookings: [],
      seasons: [
        season(
          { ...run.seasons[0].settings, regularGames: 5, maxGamesOnWeekend: 1 },
          { participants: [home, away] }
        )
      ]
    }
    const limited = buildOptions(weekly)
    expect(limited.options[0].unmet[0].cause).includes('field time')
    expect(summaryOf(weekly)).deep.equals(limited.options.map(o => o.unmet))
  })
  it('names a Manager/Head Coach the option’s own games keep busy, as the engine does', () => {
    // capacity.test's scenario: one open hour and a half on two fields, and
    // every team sharing one Manager/Head Coach.
    const saturdays = hoursOn([6], '08:00', '18:00')
    const open = {
      ...field().availability,
      startsOn: '2027-03-06',
      endsOn: '2027-03-06',
      hours: hoursOn([6], '08:00', '09:30')
    }
    const run = input({
      seasons: [
        season(
          {
            regularGames: 1,
            exhibitionGames: 0,
            endsOn: '2027-03-31',
            windows: [{ from: '2027-03-01', hours: saturdays }],
            fieldIds: ['fld_one', 'second']
          },
          { participants: ['tem_hawks', 'tem_owls', 'tem_foxes', 'tem_bears'] }
        )
      ],
      fields: [
        field({ availability: open }),
        field({ id: 'second', availability: open })
      ]
    })
    run.seed = 1
    run.headCoaches = Object.fromEntries(
      run.seasons[0].participants.map(team => [team, 'coach'])
    )
    const built = buildOptions(run)
    expect(built.options[0].unmet[0].cause).includes('Manager/Head Coach')
    const [summary] = summarizeResult(run, asPreviewResult(built)).options
    expect(summary.unmet[0].cause).includes('Manager/Head Coach')
  })
  it('accepts bounded blocked results and refuses malformed or contradictory payloads', () => {
    // A blocked result keeps the engine's reason, not the device's text.
    const blocked = { options: [], blocking: 'Anything a device sends' }
    expect(summarizeResult(input(), asPreviewResult(blocked))).deep.equals({
      options: [],
      blocking:
        'No game fits the selected fields, time windows and constraints.'
    })
    expect(
      summarizeResult(input({ fields: [] }), asPreviewResult(blocked)).blocking
    ).not.equals('Anything a device sends')
    for (const bad of [
      null,
      {},
      { options: [1, 2, 3, 4] },
      { options: [{}], blocking: null },
      { options: [], blocking: null },
      { options: [], blocking: '' },
      { options: [], blocking: 'x'.repeat(1001) },
      { options: [{ games: [] }], blocking: 'blocked' },
      { options: [{ games: Array(20001).fill({}) }], blocking: null }
    ])
      expect(() => asPreviewResult(bad)).throws()
  })
  it('stores a device’s game times as instants in one form, and refuses a time with no zone', () => {
    const game = {
      key: 'one',
      seasonId: 'sea_demo',
      homeTeamId: 'tem_hawks',
      awayTeamId: 'tem_owls',
      exhibition: false,
      fieldId: 'fld_one',
      size: '50/70',
      startAt: '2027-05-02T10:00:00+00:00',
      endAt: '2027-05-02T06:30-05:00'
    }
    const [option] = asPreviewResult({
      options: [{ games: [game] }],
      blocking: null
    }).options
    expect(option.games[0]).includes({
      startAt: '2027-05-02T10:00:00.000Z',
      endAt: '2027-05-02T11:30:00.000Z'
    })
    for (const startAt of [
      '2027-05-02T10:00',
      '2027-05-02',
      'May 2 2027 10:00 UTC'
    ])
      expect(() =>
        asPreviewResult({
          options: [{ games: [{ ...game, startAt }] }],
          blocking: null
        })
      ).throws('instants with their zone')
  })
})
