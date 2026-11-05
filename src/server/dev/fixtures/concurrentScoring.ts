import { makeId } from '../../../common/ids'
import { createScoringGame, userMinter } from '../scoringGame'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** Three independent writers and a fresh, fully staffed game. */
export async function runConcurrentScoring(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'concurrent-scoring'
  const accounts = {
    'scorer-a': await createAccount(context, world, 'scorer-a', {
      first: 'Aaron',
      last: 'Judge'
    }),
    'scorer-b': await createAccount(context, world, 'scorer-b', {
      first: 'Shohei',
      last: 'Ohtani'
    }),
    coach: await createAccount(context, world, 'coach', {
      first: 'Dave',
      last: 'Roberts'
    })
  }
  const game = await context.db.transaction().execute(async trx => {
    const fixture = await createScoringGame(trx, await userMinter(trx), {
      teams: {
        away: `Meteors ${context.nonce}`,
        home: `Comets ${context.nonce}`
      },
      names: {
        away: [
          'Mike Trout',
          'Mookie Betts',
          'Freddie Freeman',
          'Bryce Harper',
          'Juan Soto',
          'Ronald Acuna',
          'Jose Ramirez',
          'Bobby Witt',
          'Corey Seager',
          'Gunnar Henderson',
          'Francisco Lindor',
          'Trea Turner'
        ],
        home: [
          'Paul Skenes',
          'Cal Raleigh',
          'Vladimir Guerrero',
          'Marcus Semien',
          'Gerrit Cole',
          'Manny Machado',
          'Kyle Tucker',
          'Julio Rodriguez',
          'Corbin Carroll',
          'Pete Alonso',
          'Rafael Devers',
          'Matt Olson'
        ]
      }
    })
    for (const [role, account] of Object.entries(accounts)) {
      for (const team of [fixture.awayTeamId, fixture.homeTeamId]) {
        await trx
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            user_id: account.userId,
            team_id: team,
            role: 'member'
          })
          .execute()
        await trx
          .insertInto('scope_roles')
          .values({
            id: makeId('scopeRole'),
            user_id: account.userId,
            scope_type: 'team',
            scope_id: team,
            role: role === 'coach' ? 'coach' : 'scorekeeper'
          })
          .execute()
      }
    }
    return fixture
  })
  return {
    world,
    nonce: context.nonce,
    accounts,
    ids: {
      game: game.games[0],
      home: game.homeTeamId,
      away: game.awayTeamId,
      ...Object.fromEntries(
        Object.entries(game.roster).flatMap(([side, ids]) =>
          ids.map((id, i) => [`${side}-${i + 1}`, id])
        )
      )
    }
  }
}
