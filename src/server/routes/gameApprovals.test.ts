import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { GameIntent } from '../../common/gameApprovals'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { realClock } from '../groups/requests'
import { setScopeRoles } from '../invites/people'
import { gameApprovalRoutes } from './gameApprovals'

/** S15: a request that changed a game tells its scoreboard; no other does. */
describe('the game approval routes and the scoreboard', function () {
  this.timeout(60000)
  let f: GroupFixture
  const written: string[] = []
  beforeEach(async () => {
    written.length = 0
    // The harness mounts its own routes first: these, with the hook, answer
    // under their own prefix.
    f = await groupFixture(undefined, undefined, (app, { db }) => {
      app.use(
        '/api/v1/hooked',
        gameApprovalRoutes(db, realClock, {
          onGameWritten: gameId => {
            written.push(gameId)
          }
        })
      )
    })
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const intent = (): GameIntent => ({
    homeTeamId: f.teamB,
    awayTeamId: f.teamA,
    seasonId: f.seasonB,
    startAt: '2029-07-01T19:00:00.000Z',
    venue: 'Demo Field',
    outsideTournament: null,
    status: 'scheduled'
  })
  const post = async (
    route: string,
    body: unknown,
    user: number
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await f.h.request('POST', `/hooked${route}`, body, user)
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>
    }
  }
  /** Settles a request: accepted at once, or by the other team's admin. */
  const settled = async (answer: {
    body: Record<string, unknown>
  }): Promise<string> => {
    if (answer.body.status === 'pending') {
      const accepted = await post(
        `/game-requests/${String(answer.body.id)}/accept`,
        {},
        101
      )
      expect(accepted.status).equals(200)
      expect(accepted.body.status).equals('accepted')
      return String(accepted.body.gameId)
    }
    expect(answer.body.status).equals('accepted')
    return String(answer.body.gameId)
  }
  /** A Game Settings proposal; `version` as read now unless given. */
  const proposeSwap = async (
    gameId: string,
    game: GameIntent,
    key: string,
    version?: string
  ): Promise<{
    status: number
    body: Record<string, unknown>
    version: string
  }> => {
    const expected =
      version ??
      (
        (await (
          await f.h.request(
            'GET',
            `/games/${gameId}/scheduling`,
            undefined,
            102
          )
        ).json()) as { version: string }
      ).version
    const answer = await post(
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonB },
        game,
        gameId,
        expected,
        idempotencyKey: key
      },
      102
    )
    return { ...answer, version: expected }
  }

  it('tells the scoreboard of an accepted swap, and of no new game or refused one', async function () {
    const created = await post(
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonB },
        game: intent(),
        idempotencyKey: 'hooked-new-game'
      },
      102
    )
    expect(created.status).equals(201)
    const gameId = await settled(created)
    // A new game is on no scoreboard yet.
    expect(written).deep.equals([])

    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(102),
      { admin: true, flags: [] },
      userIdOfGumbo(101)
    )
    const swapped = { ...intent(), homeTeamId: f.teamA, awayTeamId: f.teamB }
    const swap = await proposeSwap(gameId, swapped, 'hooked-swap')
    expect(swap.status).equals(201)
    expect(await settled(swap)).equals(gameId)
    expect(written).deep.equals([gameId])

    // Once an at-bat is under way the swap back is refused, and told nowhere.
    await sql`update games set "currentPlay" = '{}'::jsonb where id = ${gameId}`.execute(
      f.h.db
    )
    written.length = 0
    const refused = await proposeSwap(gameId, intent(), 'hooked-swap-back')
    expect(refused.status).equals(409)
    expect(refused.body.message).equals(
      'Home and away can be swapped only before the first pitch'
    )
    expect(written).deep.equals([])
  })
})
