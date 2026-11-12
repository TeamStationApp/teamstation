import { makeId } from '../../../common/ids'
import { createTeam } from '../../teams/createTeam'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

const PEOPLE = {
  coach: { first: 'Dave', last: 'Roberts' },
  viewer: { first: 'Clayton', last: 'Kershaw' },
  player: { first: 'Mookie', last: 'Betts' }
}

/**
 * What the streaming scripts film and watch: a coach who administers the home
 * team, so may film its games; a member who may watch them but not film; a
 * player for the walk-up song; a game with no cameras yet; and a game that
 * already has two videos, so its page shows angle pills.
 */
export async function runStreaming(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'streaming'
  const coach = await createAccount(context, world, 'coach', PEOPLE.coach)
  const viewer = await createAccount(context, world, 'viewer', PEOPLE.viewer)
  const player = await createAccount(context, world, 'player', PEOPLE.player)
  const home = await createTeam(
    db,
    { name: `Dodgers ${nonce}`, externalIds: [] },
    { userId: coach.userId, isAdmin: false }
  )
  const away = await createTeam(
    db,
    { name: `Giants ${nonce}`, externalIds: [] },
    { userId: coach.userId, isAdmin: false }
  )
  for (const [member, isPlayer] of [
    [viewer, false],
    [player, true]
  ] as const) {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: member.userId as never,
        team_id: home.id,
        role: 'member',
        is_player: isPlayer
      })
      .execute()
  }
  const now = Date.now()
  const game = makeId('game')
  const gameWithVideos = makeId('game')
  await db
    .insertInto('games')
    .values([
      {
        id: game,
        home_team_id: home.id,
        away_team_id: away.id,
        start_at: new Date(now),
        venue: 'Stream Field',
        status: 'scheduled'
      },
      {
        id: gameWithVideos,
        home_team_id: home.id,
        away_team_id: away.id,
        start_at: new Date(now - 3600_000),
        venue: 'Stream Field',
        status: 'scheduled'
      }
    ])
    .execute()
  const videos = [makeId('video'), makeId('video')]
  await db
    .insertInto('videos')
    .values(
      videos.map((id, index) => ({
        id,
        game_id: gameWithVideos,
        kind: 'program' as const,
        title: index === 0 ? 'Home Plate' : 'First Base',
        storage: 'local' as const,
        status: 'ready' as const,
        start_at: new Date(now - 3600_000),
        start_at_source: 'manual' as const,
        duration_sec: 600
      }))
    )
    .execute()
  return {
    world,
    nonce,
    accounts: { coach, viewer, player },
    ids: {
      homeTeam: home.id,
      awayTeam: away.id,
      game,
      gameWithVideos,
      videoA: videos[0],
      videoB: videos[1]
    }
  }
}
