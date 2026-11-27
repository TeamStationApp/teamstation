import { ensureGumboId } from '../../users/insertUser'
import { joinTeam } from '../lineupFixture'
import { createScoringGame, userMinter } from '../scoringGame'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** The away side: a switch-hitting pitcher who wears 00, then Player 2 … 9. */
const AWAY = [
  'Jordan K.',
  ...Array.from({ length: 8 }, (_, i) => `Player ${i + 2}`)
]
/** The home side, Player 1 … 9. */
const HOME = Array.from({ length: 9 }, (_, i) => `Player ${i + 1}`)

/**
 * The scoring screen's field tests: Owls at Hawks, one scheduled game with
 * no plays, no score and no saved lineup, nine players a side playing P to
 * RF in that order (the away pitcher, Jordan K., wears 00 and switch-hits;
 * everybody else bats and throws right, and wears his number), and one
 * scorer who keeps score for both teams. `away1` … `away9` and `home1` …
 * `home9` are the players' gumbo ids in batting order, `awayUser1` … the
 * user ids.
 */
export async function runScoringField(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'scoring-field'
  const scorer = await createAccount(context, world, 'scorer', {
    first: 'Alex',
    last: 'Cora'
  })
  const ids = await context.db.transaction().execute(async trx => {
    const made = await createScoringGame(trx, await userMinter(trx), {
      names: { away: AWAY, home: HOME },
      teams: { away: 'Owls', home: 'Hawks' }
    })
    await joinTeam(trx, scorer.userId, made.awayTeamId, 'scorekeeper')
    await joinTeam(trx, scorer.userId, made.homeTeamId, 'scorekeeper')
    const found: Record<string, string> = {
      game: made.games[0],
      awayTeam: made.awayTeamId,
      homeTeam: made.homeTeamId
    }
    for (const side of ['away', 'home'] as const) {
      const teamId = side === 'away' ? made.awayTeamId : made.homeTeamId
      for (const [i, userId] of made.roster[side].entries()) {
        const pitcher = side === 'away' && i === 0
        await trx
          .updateTable('users')
          .set({ bats: pitcher ? 'switch' : 'right', throws: 'right' })
          .where('id', '=', userId)
          .execute()
        if (pitcher)
          await trx
            .updateTable('memberships')
            .set({ jersey: '00' })
            .where('user_id', '=', userId)
            .where('team_id', '=', teamId)
            .execute()
        found[`${side}${i + 1}`] = String(await ensureGumboId(trx, userId))
        found[`${side}User${i + 1}`] = userId
      }
    }
    return found
  })
  return { world, nonce: context.nonce, accounts: { scorer }, ids }
}
