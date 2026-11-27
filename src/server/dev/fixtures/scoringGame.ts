import { sql } from 'kysely'

import { makeId } from '../../../common/ids'
import { ensureGumboId } from '../../users/insertUser'
import { createScoringGame, userMinter } from '../scoringGame'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

const PEOPLE = {
  scorer: { first: 'Joe', last: 'Torre' },
  viewer: { first: 'Bernie', last: 'Williams' }
}

/** How many fresh games the world schedules: a scenario that compares two takes both. */
const GAMES = 2

/**
 * What the scoring screen's server tests score: `npm run scoring-game`'s
 * league, season and two teams of twelve (`Host 01` … and `Visitor 01` …,
 * the first nine batting one to nine and playing P to RF), with two
 * scheduled games and no plays. The teams belong to the season's league and
 * are parented by the season, and the scorer, an administrator as `npm run
 * seed` makes one, keeps score for the season. The viewer is a member of the
 * home team and nothing more. `away` and `home` are the first nine of each
 * side's gumbo ids, in batting order, and `awayUsers` and `homeUsers` their
 * user ids.
 */
export async function runScoringGame(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'scoring-game'
  const scorer = await createAccount(context, world, 'scorer', PEOPLE.scorer, {
    isAdmin: true
  })
  const viewer = await createAccount(context, world, 'viewer', PEOPLE.viewer)
  const made = await context.db.transaction().execute(async trx => {
    const mint = await userMinter(trx)
    const fixture = await createScoringGame(trx, mint, { games: GAMES })
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
        user_id: scorer.userId,
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
    return fixture
  })
  const gumbos = async (side: 'home' | 'away'): Promise<string> =>
    (
      await Promise.all(
        made.roster[side]
          .slice(0, 9)
          .map(async id => await ensureGumboId(context.db, id))
      )
    ).join(',')
  return {
    world,
    nonce: context.nonce,
    accounts: { scorer, viewer },
    ids: {
      game: made.games[0],
      games: made.games.join(','),
      season: made.seasonId,
      league: made.leagueId,
      homeTeam: made.homeTeamId,
      awayTeam: made.awayTeamId,
      away: await gumbos('away'),
      home: await gumbos('home'),
      awayUsers: made.roster.away.slice(0, 9).join(','),
      homeUsers: made.roster.home.slice(0, 9).join(',')
    }
  }
}
