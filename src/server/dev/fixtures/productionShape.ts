import { makeId } from '../../../common/ids'
import type { FixtureManifest, WorldContext } from './accounts'
import { runReplayGames } from './replayGames'

/** How long ago the played game started: inside home's three-day window. */
const PLAYED_AGO_MS = 3 * 3600_000
/** The replay fixture's game in progress, moved back out of the way. */
const OLDER_AGO_MS = 2 * 24 * 3600_000

/**
 * A game shaped like production's for the playback reliability scenarios:
 * the replay fixture's finished game, scored play by play, started three
 * hours ago, so it is the newest game its viewer played and home's Recent
 * Game card shows it; and a game of the same teams starting now, with no
 * plays, for the cameras a live scenario sends. The scenario makes the
 * finished game's four program angles of test pattern on the stack, and
 * the live game's cameras, itself.
 *
 * `viewer` is a member of the home team and watches; `scorer` keeps its
 * score and may film its games.
 */
export async function runProductionShape(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db } = context
  const base = await runReplayGames(context)
  const now = Date.now()
  await db
    .updateTable('games')
    .set({ start_at: new Date(now - PLAYED_AGO_MS), status: 'final' })
    .where('id', '=', base.ids.finalGame)
    .execute()
  await db
    .updateTable('games')
    .set({ start_at: new Date(now - OLDER_AGO_MS) })
    .where('id', '=', base.ids.inProgressGame)
    .execute()
  // The live scenario's cameras are the scorer's: filming wants the role.
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: base.accounts.scorer.userId,
      scope_type: 'team',
      scope_id: base.ids.homeTeam,
      role: 'videographer'
    })
    .execute()
  const liveGame = makeId('game')
  await db
    .insertInto('games')
    .values({
      id: liveGame,
      home_team_id: base.ids.homeTeam,
      away_team_id: base.ids.awayTeam,
      season_id: base.ids.season,
      start_at: new Date(now),
      venue: 'Replay Field',
      status: 'scheduled'
    })
    .execute()
  return {
    world: 'production-shape',
    nonce: base.nonce,
    accounts: { viewer: base.accounts.team, scorer: base.accounts.scorer },
    ids: {
      ...base.ids,
      playedGame: base.ids.finalGame,
      liveGame,
      playedStartAt: new Date(now - PLAYED_AGO_MS).toISOString()
    }
  }
}
