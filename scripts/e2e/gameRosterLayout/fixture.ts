/**
 * The signed-in game the roster layout scenario opens, on top of the
 * existing-player fixture already in this machine's database.
 *
 *   node -r sucrase/register scripts/e2e/gameRosterLayout/fixture.ts \
 *     --origin <web origin> [--fixture <existing-player fixture.json>]
 *
 * Adds Mike Trout to the Falcons' side of their game as a game-only player,
 * then prints a one-time sign-in link for the Falcons' coach that lands on
 * their game screen. The link is the only secret; it is printed,
 * not stored, and is spent by the first browser that opens it.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import {
  createEmailCode,
  signInLink
} from '../../../src/server/auth/emailCodes'
import { makeDatabase } from '../../../src/server/db/database'
import { createGuestPlayer } from '../../../src/server/games/guestPlayers'
import { serverConfig } from '../../../src/server/serverConfig'

const { values } = parseArgs({
  options: {
    origin: { type: 'string' },
    fixture: {
      type: 'string',
      default: '/private/tmp/teamstation-existingPlayer/fixture.json'
    }
  }
})

interface ExistingPlayerFixture {
  gameId: string
  teams: { falcons: { id: string } }
  emails: { coach: string }
  accounts: { coach: string }
}

async function main(): Promise<void> {
  if (values.origin == null) throw new Error('--origin is required')
  const fixture = JSON.parse(
    readFileSync(values.fixture, 'utf8')
  ) as ExistingPlayerFixture
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    await createGuestPlayer(
      db,
      { userId: fixture.accounts.coach, isAdmin: false },
      fixture.gameId,
      'home',
      {
        firstName: 'Mike',
        lastName: 'Trout',
        jersey: '27',
        positions: [],
        bats: 'right',
        throws: 'right'
      },
      fixture.teams.falcons.id
    )
    const { token } = await createEmailCode(db, fixture.emails.coach, 'login', {
      next: `/games/${fixture.gameId}/coach/${fixture.teams.falcons.id}`
    })
    console.log(
      JSON.stringify({ url: signInLink(values.origin, token, null, true) })
    )
  } finally {
    await db.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
