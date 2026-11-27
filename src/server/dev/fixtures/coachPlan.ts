import { createLineupGame, joinTeam } from '../lineupFixture'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/**
 * The people `lineup-fixture` gives the lineup game, by the role a test
 * signs them in as: the scorekeeper of both sides, the home team's head
 * coach and its assistant, the visitors' head coach, a member of the home
 * team who neither scores nor coaches, and an admin of the home team who is
 * not its coach.
 */
const PEOPLE = {
  scorekeeper: {
    person: { first: 'Alex', last: 'Cora' },
    sides: ['away', 'home'],
    role: 'scorekeeper'
  },
  headCoach: {
    person: { first: 'Aaron', last: 'Boone' },
    sides: ['home'],
    role: 'coach'
  },
  assistant: {
    person: { first: 'Don', last: 'Mattingly' },
    sides: ['home'],
    role: 'assistant'
  },
  awayCoach: {
    person: { first: 'Dave', last: 'Roberts' },
    sides: ['away'],
    role: 'coach'
  },
  member: {
    person: { first: 'Derek', last: 'Jeter' },
    sides: ['home'],
    role: undefined
  },
  teamAdmin: {
    person: { first: 'Brian', last: 'Cashman' },
    sides: ['home'],
    role: 'admin'
  }
} as const

/**
 * The coaching screen's tests: the lineup game (Visitors at Hosts, thirteen
 * players a side, each side's first nine its default lineup, player i
 * wearing i and named as `LINEUP_NAMES` names him) with the six people
 * above. `home<i>Gumbo` and `home<i>User` (and `away…`) are player i's
 * gumbo id and user id, i from 1 to 13 in roster order.
 */
export async function runCoachPlan(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'coach-plan'
  const accounts: FixtureManifest['accounts'] = {}
  for (const [role, { person }] of Object.entries(PEOPLE))
    accounts[role] = await createAccount(context, world, role, person)
  const game = await context.db.transaction().execute(async trx => {
    const made = await createLineupGame(trx)
    for (const [role, { sides, role: teamRole }] of Object.entries(PEOPLE))
      for (const side of sides)
        await joinTeam(trx, accounts[role].userId, made.teams[side], teamRole)
    return made
  })
  const ids: Record<string, string> = {
    game: game.gameId,
    season: game.seasonId,
    homeTeam: game.teams.home,
    awayTeam: game.teams.away
  }
  for (const side of ['home', 'away'] as const)
    game.players[side].forEach((player, at) => {
      ids[`${side}${at + 1}Gumbo`] = String(player.gumboId)
      ids[`${side}${at + 1}User`] = player.userId
    })
  return { world, nonce: context.nonce, accounts, ids }
}
