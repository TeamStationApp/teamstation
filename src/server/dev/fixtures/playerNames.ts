import { randomBytes } from 'node:crypto'

import { createNamesFixture } from '../namesFixture'
import type { FixtureAccount, FixtureManifest, WorldContext } from './accounts'
import { testAddress } from './address'

/**
 * The player-name scenarios' data (`src/server/dev/namesFixture.ts`) as a
 * world: two teams of major leaguers in a season, a scored game, the
 * visitors run by two administrators who score their games and sign in
 * with a password of this world's own. Its people's addresses are `+`
 * addresses on the stack's test mailbox, stamped by the world's nonce.
 * `awayPlayers` and `homePlayers` are each side's players in order, as JSON
 * (`[{ userId, gumboId, name, jersey }]`).
 */
export async function runPlayerNames(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'player-names'
  const password = randomBytes(18).toString('base64url')
  const fixture = await createNamesFixture(context.db, {
    password,
    stamp: `${world}-${context.nonce}`,
    // On the stack's test mailbox: a seed refuses a database holding any
    // other address, so `example.test` ones would stop every later world.
    address: who =>
      testAddress(
        context.mailbox,
        `${world}-${who.toLowerCase()}-${context.nonce}`
      )
  })
  const account = (role: 'admin' | 'secondAdmin'): FixtureAccount => ({
    role,
    email: fixture.people[role].email,
    password,
    userId: fixture.people[role].userId,
    displayName: fixture.people[role].name
  })
  return {
    world,
    nonce: context.nonce,
    accounts: { admin: account('admin'), secondAdmin: account('secondAdmin') },
    ids: {
      season: fixture.seasonId,
      homeTeam: fixture.teams.home,
      awayTeam: fixture.teams.away,
      game: fixture.gameId,
      awayPlayers: JSON.stringify(fixture.players.away),
      homePlayers: JSON.stringify(fixture.players.home)
    }
  }
}
