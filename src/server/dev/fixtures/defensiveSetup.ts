import { makeId } from '../../../common/ids'
import { ensureGumboId } from '../../users/insertUser'
import { createScoringGame, userMinter } from '../scoringGame'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** Each side's ten players, in roster order, jerseys 1 to 10. */
export const DEFENSIVE_SETUP_NAMES = [
  'Mookie Betts',
  'Mike Trout',
  'Shohei Ohtani',
  'Aaron Judge',
  'Bryce Harper',
  'Freddie Freeman',
  'Francisco Lindor',
  'Juan Soto',
  'Bobby Witt',
  'Julio Rodriguez'
] as const

/**
 * The defensive setup's game: the Owls at the Hawks, scheduled and
 * unscored, each side's ten players named `DEFENSIVE_SETUP_NAMES` in that
 * order, wearing 1 to 10, the first nine playing P to RF, every one batting
 * and throwing right. The scorer keeps score for both teams. Neither team
 * has a default lineup: a scenario sets the one it needs. `away` and `home`
 * are each side's ten gumbo ids in roster order, `awayUsers` and
 * `homeUsers` their user ids, and `scorerGumbo` the scorer's.
 */
export async function runDefensiveSetup(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'defensive-setup'
  const scorer = await createAccount(context, world, 'scorer', {
    first: 'Bob',
    last: 'Uecker'
  })
  const made = await context.db.transaction().execute(async trx => {
    const fixture = await createScoringGame(trx, await userMinter(trx), {
      teams: { away: 'Owls', home: 'Hawks' },
      names: { away: DEFENSIVE_SETUP_NAMES, home: DEFENSIVE_SETUP_NAMES }
    })
    await trx
      .updateTable('users')
      .set({ bats: 'right', throws: 'right' })
      .where('id', 'in', [...fixture.roster.away, ...fixture.roster.home])
      .execute()
    for (const team of [fixture.awayTeamId, fixture.homeTeamId]) {
      await trx
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: scorer.userId,
          team_id: team,
          role: 'member'
        })
        .execute()
      await trx
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: scorer.userId,
          scope_type: 'team',
          scope_id: team,
          role: 'scorekeeper'
        })
        .execute()
    }
    return fixture
  })
  const gumbos = async (users: string[]): Promise<string> =>
    (
      await Promise.all(
        users.map(async id => await ensureGumboId(context.db, id))
      )
    ).join(',')
  return {
    world,
    nonce: context.nonce,
    accounts: { scorer },
    ids: {
      game: made.games[0],
      awayTeam: made.awayTeamId,
      homeTeam: made.homeTeamId,
      away: await gumbos(made.roster.away),
      home: await gumbos(made.roster.home),
      awayUsers: made.roster.away.join(','),
      homeUsers: made.roster.home.join(','),
      scorerGumbo: String(await ensureGumboId(context.db, scorer.userId))
    }
  }
}
