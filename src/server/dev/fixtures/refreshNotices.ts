import { randomUUID } from 'node:crypto'

import { makeId } from '../../../common/ids'
import { createTeam } from '../../teams/createTeam'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

const PEOPLE = {
  spectator: { first: 'Sam', last: 'Spectator' },
  scorer: { first: 'Kim', last: 'Scorer' },
  admin: { first: 'Ada', last: 'Admin' }
}

/** How many games the spectator sees: a busy season's schedule. */
const VISIBLE_GAMES = 320
const HOUR_MS = 3_600_000

/**
 * A busy schedule for the refresh and offline-scoring scenarios: a spectator
 * on four teams that play 320 games between them, a scorekeeper given the
 * role on three of those teams (four games in the next 96 hours, the fourth
 * the farthest), and an administrator of one team who holds no scorekeeper
 * role. Games are an hour apart from tomorrow on, and a few before today.
 */
export async function runRefreshNotices(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'refresh-notices'
  const spectator = await createAccount(
    context,
    world,
    'spectator',
    PEOPLE.spectator
  )
  const scorer = await createAccount(context, world, 'scorer', PEOPLE.scorer)
  const admin = await createAccount(context, world, 'admin', PEOPLE.admin)
  const names = ['Hawks', 'Owls', 'Jays', 'Wrens']
  const teams: string[] = []
  for (const name of names) {
    const team = await createTeam(
      db,
      { name: `${name} ${nonce}`, externalIds: [] },
      { userId: admin.userId, isAdmin: false }
    )
    teams.push(team.id)
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: spectator.userId as never,
        team_id: team.id,
        role: 'member',
        is_player: false
      })
      .execute()
  }
  for (const teamId of teams.slice(0, 3))
    await db
      .insertInto('scope_roles')
      .values({
        id: randomUUID(),
        user_id: scorer.userId as never,
        scope_type: 'team',
        scope_id: teamId,
        role: 'scorekeeper',
        granted_by: admin.userId as never
      })
      .execute()
  const now = Date.now()
  const games: string[] = []
  for (let i = 0; i < VISIBLE_GAMES; i++) {
    const home = teams[i % teams.length]
    const away = teams[(i + 1) % teams.length]
    // Four games in the next 96 hours on the scorer's teams, the rest after
    // them, and the first ten already played.
    const hours =
      i < 10 ? -24 * (10 - i) : i < 14 ? 2 + (i - 10) * 20 : 100 + i * 3
    const id = makeId('game')
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        start_at: new Date(now + hours * HOUR_MS),
        status: i < 10 ? 'final' : 'scheduled',
        home_score: i < 10 ? 3 : null,
        away_score: i < 10 ? 2 : null
      })
      .execute()
    games.push(id)
  }
  return {
    world,
    nonce,
    accounts: { spectator, scorer, admin },
    ids: {
      teams: teams.join(','),
      soon: games.slice(10, 14).join(','),
      far: games[14]
    }
  }
}
