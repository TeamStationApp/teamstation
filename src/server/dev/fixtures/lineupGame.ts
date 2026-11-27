import { sql } from 'kysely'

import { createLineupGame, joinTeam } from '../lineupFixture'
import {
  createAccount,
  type FixtureAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** The six people of `npm run lineup-fixture`, by role, with its names. */
const PEOPLE = {
  scorekeeper: { first: 'Alex', last: 'Cora' },
  headCoach: { first: 'Aaron', last: 'Boone' },
  assistant: { first: 'Don', last: 'Mattingly' },
  awayCoach: { first: 'Dave', last: 'Roberts' },
  member: { first: 'Derek', last: 'Jeter' },
  teamAdmin: { first: 'Brian', last: 'Cashman' }
}

/** Where each person sits: the teams they join, and their role on each. */
const PLACES: Record<
  keyof typeof PEOPLE,
  {
    sides: Array<'home' | 'away'>
    role?: 'scorekeeper' | 'coach' | 'assistant' | 'admin'
  }
> = {
  scorekeeper: { sides: ['away', 'home'], role: 'scorekeeper' },
  headCoach: { sides: ['home'], role: 'coach' },
  assistant: { sides: ['home'], role: 'assistant' },
  awayCoach: { sides: ['away'], role: 'coach' },
  member: { sides: ['home'] },
  teamAdmin: { sides: ['home'], role: 'admin' }
}

/**
 * `npm run lineup-fixture`'s game as a world: the lineup game (Visitors at
 * Hosts, thirteen players a side, each side's first nine its default
 * lineup), a scorekeeper of both teams, the home team's head coach,
 * assistant, a plain member and an administrator who does not coach, and
 * the away team's head coach, each a fresh account of this world's own.
 * `players` is both sides' players in order, as JSON:
 * `{ away: [{ userId, gumboId, name, jersey }], home: [...] }`. Game
 * requests and Game Settings wait for the organization cutover a deployed
 * node has made, which a fresh stack has not: the world makes it.
 */
export async function runLineupGame(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'lineup-game'
  const accounts: Record<string, FixtureAccount> = {}
  for (const [role, person] of Object.entries(PEOPLE))
    accounts[role] = await createAccount(context, world, role, person)
  const game = await context.db.transaction().execute(async trx => {
    await sql`
      INSERT INTO system_settings (key, value)
      VALUES ('creation.hierarchyReady', 'true')
      ON CONFLICT (key) DO UPDATE SET value = 'true'`.execute(trx)
    const made = await createLineupGame(trx)
    for (const [role, place] of Object.entries(PLACES))
      for (const side of place.sides)
        await joinTeam(trx, accounts[role].userId, made.teams[side], place.role)
    return made
  })
  return {
    world,
    nonce: context.nonce,
    accounts,
    ids: {
      game: game.gameId,
      season: game.seasonId,
      homeTeam: game.teams.home,
      awayTeam: game.teams.away,
      players: JSON.stringify(game.players)
    }
  }
}
