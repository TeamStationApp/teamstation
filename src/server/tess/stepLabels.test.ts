import { expect } from 'chai'
import { describe, it } from 'mocha'

import { openApiDocument } from '../openapi'
import {
  NO_SUCH_TOOL,
  PREPARING_CHANGE,
  READING_API,
  stepLabel
} from './stepLabels'

const read = (path: unknown, query?: unknown): string =>
  stepLabel({ name: 'api_get', input: { path, query } })

describe("Tess's step labels", function () {
  it('names a read by the API document’s summary of its route', () => {
    const paths = openApiDocument('').paths as Record<
      string,
      { get?: { summary?: string } }
    >
    const games = paths['/teams/{teamId}/games'].get!.summary!
    expect(read('/teams/tem_hawks/games')).equals(`Reading: ${games}`)
    // Written with the prefix, a trailing slash, another case or a query.
    expect(read('/api/v1/teams/tem_hawks/games/')).equals(`Reading: ${games}`)
    expect(read('/TEAMS/tem_hawks/GAMES?season=sea_1')).equals(
      `Reading: ${games}`
    )
    // A fixed segment wins over a parameter in the same place.
    const summary = paths['/me/notifications/summary'].get!.summary!
    expect(summary).not.equals(paths['/me/notifications/{id}'].get!.summary)
    expect(read('/me/notifications/summary')).equals(`Reading: ${summary}`)
    expect(read('/me/notifications/ntf_1')).equals(
      `Reading: ${paths['/me/notifications/{id}'].get!.summary!}`
    )
  })

  it('falls back to "Reading the API" for a route it cannot name or a call it cannot read', () => {
    expect(read('/no/such/route')).equals(READING_API)
    expect(read(42)).equals(READING_API)
    expect(stepLabel({ name: 'api_get', input: null })).equals(READING_API)
    expect(stepLabel({ name: 'api_get', input: 'teams' })).equals(READING_API)
  })

  it('says what a refused call may not do, in the refusal’s first sentence', () => {
    expect(read('/me/account')).equals(
      'Not allowed: Tess may not use sign-in, account, device key, test build, OAuth, dictation or Tess routes.'
    )
    // A reason of one sentence without its stop gets one.
    expect(read('/teams/../me/account')).equals(
      'Not allowed: That path is not allowed.'
    )
    expect(read('https://example.test/teams')).equals(
      'Not allowed: Give a path under /api/v1, starting with /, such as /teams, not a URL.'
    )
    expect(
      stepLabel({
        name: 'confirmChange',
        input: { method: 'POST', path: '/games/gam_1/events', summary: 'x' }
      })
    ).equals(
      'Not allowed: Tess may not change live scoring, lineups during a game, live video or the Director.'
    )
  })

  it('labels a proposed change, and a tool there is not', () => {
    expect(
      stepLabel({
        name: 'confirmChange',
        input: { method: 'POST', path: '/teams/tem_1/games', summary: 'Add' }
      })
    ).equals(PREPARING_CHANGE)
    expect(
      stepLabel({ name: 'confirmChange', input: { method: 'GET', path: 1 } })
    ).equals(PREPARING_CHANGE)
    expect(stepLabel({ name: 'runSql', input: {} })).equals(NO_SUCH_TOOL)
  })

  it('never names an id, a query value or a body', () => {
    const secret = 'tem_secret_9f3c'
    for (const label of [
      read(`/teams/${secret}/games`, { season: 'sea_secret_9f3c' }),
      read(`/teams/${secret}/games?season=sea_secret_9f3c`),
      read(`/no/${secret}`),
      read(`/me/account/${secret}`),
      stepLabel({
        name: 'confirmChange',
        input: {
          method: 'POST',
          path: `/teams/${secret}/games`,
          body: { name: secret },
          summary: `Add ${secret}`
        }
      }),
      stepLabel({ name: `tool_${secret}`, input: {} })
    ])
      expect(label).not.contains('secret')
  })
})
