import assert from 'node:assert/strict'
import { mock } from 'node:test'

import { expect } from 'chai'
import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { GAME_SOCKET_PROTOCOL, PROTOCOL_HEADER } from '../../common/gameSocket'
import type { GumboPlay } from '../../common/gumboPlay'
import { foldFinal } from '../../common/scoring/gumbo'
import { setupOf } from '../../common/scoring/state'
import {
  SCORING_FEATURE_HEADER,
  SCORING_FEATURES
} from '../../common/scoring/teamRecord'
import { userIdOfGumbo } from '../../common/userId'
import { withQueryReplies } from '../../test/queryReplies'
import { game, TEAMS } from '../../test/scoringGames'
import type { Database } from '../db/database'
import * as eventTags from '../events/eventTags'
import * as visibility from '../events/requireVisibleGame'
import * as naming from '../scoring/openRow'
import { eventRoutes } from './events'

const previous = 'deferred-lineups-v1'
const final = foldFinal(game(), {
  setupBefore: setupOf(game()),
  actions: [{ type: 'gameFlow', kind: 'endGame' }],
  liveScoring: true
})
const row = {
  id: 'g1',
  home_team_id: TEAMS.home.id,
  away_team_id: TEAMS.away.id,
  currentPlay: null,
  pregame: null,
  lineups_digest: 'lineups',
  status: 'live',
  scoringOwner: 'teamstation'
}

async function request(
  db: Kysely<Database>,
  method: 'GET' | 'POST',
  features: string,
  body?: unknown
): Promise<unknown> {
  const headers = new Map([
    [SCORING_FEATURE_HEADER, features],
    [PROTOCOL_HEADER, String(GAME_SOCKET_PROTOCOL)]
  ])
  const get = (header: string): string | undefined => headers.get(header)
  return await new Promise((resolve, reject) =>
    eventRoutes(db)(
      {
        url: '/games/g1/events',
        method,
        query: {},
        body,
        get,
        header: get,
        actor: { userId: userIdOfGumbo(1), isAdmin: false, scopes: [] }
      } as unknown as Request,
      { locals: {}, json: resolve } as unknown as Response,
      reject
    )
  )
}

describe('scoring record versions at the events route', () => {
  beforeEach(() => {
    mock.method(visibility, 'requireVisibleGame', async () => undefined)
  })
  afterEach(() => {
    mock.restoreAll()
  })

  for (const features of [previous, SCORING_FEATURES])
    it(`reads an interrupted final with the advertised capabilities ${features}`, async () => {
      mock.method(eventTags, 'eventTagsNeedRepair', async () => false)
      mock.method(
        naming,
        'namedScoringGame',
        async (_db: unknown, stored: unknown) => ({
          game: stored,
          names: { digest: 'names' }
        })
      )
      await withQueryReplies(
        query => {
          if (query.sql.includes('from "events"'))
            return [{ id: 'final', gameId: 'g1', gumbo: final }]
          if (query.sql.includes('from "games"')) return [row]
          return []
        },
        async db => {
          const response = request(db, 'GET', features)
          if (features === previous)
            await assert.rejects(response, {
              status: 409,
              message: /Update TeamStation to open scoring/
            })
          else {
            const answer = (await response) as {
              plays: Array<{ gumbo: GumboPlay }>
            }
            expect(answer.plays.map(play => play.gumbo)).deep.equals([final])
          }
        }
      )
    })

  for (const source of ['stored', 'posted', 'history', 'pregame'])
    it(`refuses an old client's write with an unsupported record in ${source}`, async () => {
      let locked = false
      await withQueryReplies(
        query => {
          expect(query.sql).matches(/^select /i)
          if (query.sql.includes('for update')) locked = true
          if (query.sql.includes('from "games"'))
            return [
              source === 'pregame' ? { ...row, pregame: { version: 4 } } : row
            ]
          if (source === 'stored' && query.sql.includes('from "events"'))
            return [{ id: 'final', gameId: 'g1', gumbo: final }]
          return []
        },
        async db => {
          await assert.rejects(
            request(db, 'POST', source === 'pregame' ? '' : previous, {
              mode: 'live',
              source: { system: 'teamstation' },
              plays: source === 'posted' ? [final] : [],
              ...(source === 'history' ? { scoringHistory: [final] } : {})
            }),
            { status: 409, message: /Update TeamStation to score this game/ }
          )
          expect(locked).equals(true)
        }
      )
    })

  it('rejects an unknown version before writing any play', async () => {
    // The one read is whether the game has a side open (`fillOpenSides`).
    const sides = 'select "home_team_id", "away_team_id" from "games"'
    await withQueryReplies([[sides, [row]]], async db => {
      await assert.rejects(
        request(db, 'POST', SCORING_FEATURES, {
          mode: 'live',
          source: { system: 'teamstation' },
          plays: [{ ...final, teamStation: { version: 6 } }]
        }),
        {
          status: 400,
          message: /Play 9999: teamStation must be a valid version/
        }
      )
    })
  })
})
