import { sql } from 'kysely'

import { makeId } from '../../../common/ids'
import { createScoringGame, userMinter } from '../scoringGame'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

const PEOPLE = {
  admin: { first: 'Odessa', last: 'Pellworth' },
  viewer: { first: 'Florian', last: 'Quenby' }
}

/** Before the scoreboard overlay's start date: no board is drawn on these games. */
export const BEFORE_OVERLAY = '2026-09-15T17:00:00Z'

/**
 * The rows of the games the player-layouts scenarios watch, as the old
 * player-layouts fixture script made them: `npm run scoring-game`'s
 * league, season and two teams of twelve with six games, an administrator
 * (as `npm run seed` makes one) who keeps score for the season and may film
 * any game, and a member of the home team. The games are, in order:
 *
 * - **S**, to be scored and recorded on four angles;
 * - **L**, to carry scoreboard-log rows and no plays, on two angles;
 * - **N** and **N0**, both before the overlay's start date, so no board is
 *   drawn on them: N to be scored, N0 to have no events;
 * - **U**, for one uploaded angle with no start time;
 * - **V**, to be live.
 *
 * The media are no world's: each scenario records or uploads them on the
 * stack itself (`e2e/tests/playback/player-layouts/games.ts`).
 */
export async function runPlayerLayouts(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'player-layouts'
  const admin = await createAccount(context, world, 'admin', PEOPLE.admin, {
    isAdmin: true
  })
  const viewer = await createAccount(context, world, 'viewer', PEOPLE.viewer)
  const made = await context.db.transaction().execute(async trx => {
    const mint = await userMinter(trx)
    const fixture = await createScoringGame(trx, mint, { games: 6 })
    const leagueOf = await trx
      .selectFrom('seasons')
      .select('league_id')
      .where('id', '=', fixture.seasonId)
      .executeTakeFirstOrThrow()
    await trx
      .updateTable('teams')
      .set({ league_id: leagueOf.league_id })
      .where('id', 'in', [fixture.homeTeamId, fixture.awayTeamId])
      .execute()
    await sql`
      INSERT INTO season_team_parents (team_id, season_id)
      VALUES (${fixture.homeTeamId}, ${fixture.seasonId}),
             (${fixture.awayTeamId}, ${fixture.seasonId})
      ON CONFLICT DO NOTHING`.execute(trx)
    await trx
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: admin.userId,
        scope_type: 'season',
        scope_id: fixture.seasonId,
        role: 'scorekeeper'
      })
      .execute()
    await trx
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: viewer.userId,
        team_id: fixture.homeTeamId,
        role: 'member'
      })
      .execute()
    const [, , N, N0] = fixture.games
    await trx
      .updateTable('games')
      .set({ start_at: new Date(BEFORE_OVERLAY) })
      .where('id', 'in', [N, N0])
      .execute()
    return fixture
  })
  const [S, L, N, N0, U, V] = made.games
  return {
    world,
    nonce: context.nonce,
    accounts: { admin, viewer },
    ids: {
      S,
      L,
      N,
      N0,
      U,
      V,
      season: made.seasonId,
      league: made.leagueId,
      homeTeam: made.homeTeamId,
      awayTeam: made.awayTeamId
    }
  }
}
