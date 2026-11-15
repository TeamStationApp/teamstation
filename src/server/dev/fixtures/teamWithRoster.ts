import { makeId } from '../../../common/ids'
import { createTeam } from '../../teams/createTeam'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

const PEOPLE = {
  coach: { first: 'Dave', last: 'Roberts' },
  player: { first: 'Mookie', last: 'Betts' },
  teammate: { first: 'Freddie', last: 'Freeman' }
}

/** A standalone team with a coach and two players, under this run's nonce. */
export async function runTeamWithRoster(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'team-with-roster'
  const coach = await createAccount(context, world, 'coach', PEOPLE.coach)
  const player = await createAccount(context, world, 'player', PEOPLE.player)
  const teammate = await createAccount(
    context,
    world,
    'teammate',
    PEOPLE.teammate
  )
  const team = await createTeam(
    db,
    { name: `Sox ${nonce}`, externalIds: [] },
    { userId: coach.userId, isAdmin: false }
  )
  for (const member of [player, teammate]) {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: member.userId as never,
        team_id: team.id,
        role: 'member'
      })
      .execute()
  }
  return {
    world,
    nonce,
    accounts: { coach, player, teammate },
    ids: { team: team.id }
  }
}
