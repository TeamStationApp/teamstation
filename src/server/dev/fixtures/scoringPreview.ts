import type { Transaction } from 'kysely'

import type {
  StoredDefaultLineup,
  StoredLineup
} from '../../../common/scoring/lineupHistory'
import { POSITIONS } from '../../../common/scoring/state'
import type { Database } from '../../db/database'
import { ensureGumboId } from '../../users/insertUser'
import { joinTeam } from '../lineupFixture'
import {
  createScoringGame,
  type ScoringGameFixture,
  userMinter
} from '../scoringGame'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** How many fresh games a scenario may open, one after another. */
export const PREVIEW_GAMES = 10

/**
 * The scoring screen's preview game, as the phone-browser scoring scenarios
 * read it: the Owls at the Hawks. The Owls bat Jordan K. (who pitches, and
 * wears 00) and Player 2 to Player 9, the Hawks Player 1 to Player 9, each
 * playing P to RF in batting order and batting right-handed. Each team's
 * default lineup is those nine, so a game opens straight to its first pitch.
 */
export const PREVIEW_NAMES: Record<'home' | 'away', readonly string[]> = {
  away: [
    'Jordan K.',
    ...Array.from({ length: 8 }, (_, i) => `Player ${i + 2}`)
  ],
  home: Array.from({ length: 9 }, (_, i) => `Player ${i + 1}`)
}

/**
 * Sets each team's default lineup to its first nine, batting one to nine and
 * playing P to RF, so its games open straight to the first pitch. `leadJersey`
 * is the jersey a side's leadoff wears when it is not 1.
 */
export async function setDefaultLineups(
  trx: Transaction<Database>,
  game: ScoringGameFixture,
  leadJersey: Partial<Record<'home' | 'away', string>> = {}
): Promise<void> {
  const teams = { home: game.homeTeamId, away: game.awayTeamId }
  for (const side of ['away', 'home'] as const) {
    const people = await Promise.all(
      game.roster[side].slice(0, POSITIONS.length).map(async (userId, i) => ({
        gumboId: await ensureGumboId(trx, userId),
        jersey: i === 0 ? (leadJersey[side] ?? '1') : String(i + 1)
      }))
    )
    const value: StoredDefaultLineup = {
      lineup: {
        batters: people,
        defense: Object.fromEntries(
          POSITIONS.map((position, i) => [position, people[i]])
        ) as StoredLineup['defense']
      },
      fromGameId: null,
      setAt: new Date().toISOString()
    }
    await trx
      .updateTable('teams')
      .set({ default_lineup: value })
      .where('id', '=', teams[side])
      .execute()
  }
}

/**
 * `PREVIEW_GAMES` scheduled games of the Owls at the Hawks, none scored, and
 * a scorer who keeps score for both teams. `ids.game1` … `ids.game10` are the
 * games, so a scenario opens a fresh one each time it starts over.
 */
export async function runScoringPreview(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'scoring-preview'
  const scorer = await createAccount(context, world, 'scorer', {
    first: 'Bob',
    last: 'Uecker'
  })
  const made = await context.db.transaction().execute(async trx => {
    const game = await createScoringGame(trx, await userMinter(trx), {
      games: PREVIEW_GAMES,
      names: PREVIEW_NAMES,
      teams: { away: 'Owls', home: 'Hawks' }
    })
    const teams = { home: game.homeTeamId, away: game.awayTeamId }
    const everyone = [...game.roster.away, ...game.roster.home]
    await trx
      .updateTable('users')
      .set({ bats: 'right', throws: 'right' })
      .where('id', 'in', everyone)
      .execute()
    // Jordan K. wears 00.
    await trx
      .updateTable('memberships')
      .set({ jersey: '00' })
      .where('user_id', '=', game.roster.away[0])
      .where('team_id', '=', teams.away)
      .execute()
    await setDefaultLineups(trx, game, { away: '00' })
    for (const side of ['away', 'home'] as const) {
      await joinTeam(trx, scorer.userId, teams[side], 'scorekeeper')
    }
    return { games: game.games, teams }
  })
  return {
    world,
    nonce: context.nonce,
    accounts: { scorer },
    ids: {
      homeTeam: made.teams.home,
      awayTeam: made.teams.away,
      ...Object.fromEntries(made.games.map((game, i) => [`game${i + 1}`, game]))
    }
  }
}
