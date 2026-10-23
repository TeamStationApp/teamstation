import assert from 'node:assert/strict'

import { makeId } from '../common/ids'
import { userIdOfGumbo } from '../common/userId'
import { demoLocality, type GroupFixture } from './groupFixtures'

/**
 * The stack transition scenarios' world, the navbarPop one: Demo Hawks with a
 * player, a scheduled game against Demo Owls with a video, and the signed-in
 * user (101) the Hawks' scorekeeper, so the game offers Score.
 */
export async function seedStack(
  f: GroupFixture
): Promise<{ gameId: string; teamId: string; playerId: string }> {
  const owls = await f.h.request(
    'POST',
    '/teams',
    {
      name: 'Demo Owls',
      parent: { kind: 'season', id: f.seasonA },
      locality: demoLocality,
      idempotencyKey: 'stack-owls'
    },
    101
  )
  assert.equal(owls.status, 201)
  const owlId = ((await owls.json()) as { id: string }).id
  const players = await f.h.request(
    'POST',
    `/teams/${f.teamA}/players`,
    {
      players: [
        {
          firstName: 'Alex',
          lastName: 'Lee',
          externalId: { system: 'demo', id: 'alex-lee', kind: 'person' }
        }
      ]
    },
    101
  )
  assert.equal(players.status, 200)
  const playerId = (
    (await players.json()) as { results: Array<{ userId?: string }> }
  ).results[0].userId
  const games = await f.h.request(
    'POST',
    `/teams/${f.teamA}/games`,
    {
      games: [
        {
          startAt: '2027-04-10T17:00:00Z',
          opponent: { teamId: owlId },
          seasonId: f.seasonA,
          side: 'home'
        }
      ]
    },
    101
  )
  assert.equal(games.status, 200)
  const scheduled = (
    (await games.json()) as {
      results: Array<{ result: string; gameId?: string }>
    }
  ).results[0]
  assert.equal(scheduled.result, 'created', JSON.stringify(scheduled))
  const gameId = scheduled.gameId!
  await f.h.db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: userIdOfGumbo(101),
      scope_type: 'team',
      scope_id: f.teamA,
      role: 'scorekeeper'
    })
    .execute()
  const now = f.clock.now()
  await f.h.db
    .insertInto('videos')
    .values({
      id: makeId('video'),
      game_id: gameId,
      kind: 'program',
      storage: 'local',
      status: 'ready',
      title: 'Demo',
      created_at: now,
      updated_at: now
    })
    .execute()
  return { gameId, teamId: f.teamA, playerId: playerId ?? '' }
}
