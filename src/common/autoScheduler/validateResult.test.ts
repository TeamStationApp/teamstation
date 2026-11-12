import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asPreviewResult } from '../schedulePreviews'
import { buildContext } from './context'
import { input, season } from './fixtures.test'
import { buildOptions } from './index'
import { summarizeResult } from './validateResult'

describe('device result summaries', () => {
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
    ).equals('1 requested games remain unplaced')
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
  it('accepts bounded blocked results and refuses malformed or contradictory payloads', () => {
    const blocked = { options: [], blocking: 'No selected fields' }
    expect(summarizeResult(input(), asPreviewResult(blocked))).deep.equals(
      blocked
    )
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
})
