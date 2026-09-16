import { makeId } from '../../common/ids'
import { createSession } from '../auth/sessions'
import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'

/**
 * Builds a league, a season, two teams, a roster, a game and a video, and
 * prints a token so the whole watch path can be walked with `curl`.
 *
 *   npm run demo
 *
 * It refuses to run in production: it writes fictional people and would be
 * nonsense in a real database.
 */
/** The home team's players, so the roster and box score have names. */
const ROSTER = ['Robin Hale', 'Ash Berger', 'Sam Ortiz']

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The demo script does not run in production')
  }

  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const leagueId = makeId('league')
    const seasonId = makeId('season')
    const homeTeamId = makeId('team')
    const awayTeamId = makeId('team')
    const gameId = makeId('game')
    const videoId = makeId('video')
    const viewerId = makeId('user')

    await db
      .insertInto('leagues')
      .values({ id: leagueId, name: 'Demo League', short_name: 'DEMO' })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: seasonId,
        league_id: leagueId,
        name: 'Demo 2026',
        age_group: '11U',
        year: 2026,
        term: 'Fall'
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: homeTeamId, name: 'Demo Home' },
        { id: awayTeamId, name: 'Demo Away' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: seasonId, team_id: homeTeamId },
        { season_id: seasonId, team_id: awayTeamId }
      ])
      .execute()

    // A viewer who belongs to the home team, so the access rules have work to
    // do rather than waving everything through.
    await db
      .insertInto('users')
      .values({ id: viewerId, display_name: 'Demo Viewer' })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: viewerId,
        team_id: homeTeamId,
        role: 'member',
        is_spectator: true
      })
      .execute()

    // Every name on the roster is a player, so plays posted later can credit
    // them and the box score has somebody to name.
    for (const displayName of ROSTER) {
      const userId = makeId('user')
      await db
        .insertInto('users')
        .values({ id: userId, display_name: displayName })
        .execute()
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: homeTeamId,
          role: 'member',
          is_player: true
        })
        .execute()
    }

    const startAt = new Date('2026-09-13T16:00:00.000Z')
    await db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        season_id: seasonId,
        start_at: startAt,
        venue: 'Demo Field',
        status: 'final'
      })
      .execute()

    await db
      .insertInto('videos')
      .values({
        id: videoId,
        game_id: gameId,
        kind: 'program',
        title: 'Demo Home vs Demo Away',
        storage: 'local',
        status: 'ready',
        start_at: startAt,
        start_at_source: 'manual',
        duration_sec: 7200
      })
      .execute()

    const session = await createSession(db, viewerId, 'demo script')

    // Somebody who belongs to nothing, so the access rules can be shown to
    // actually withhold rather than merely be present. Not an administrator:
    // an administrator sees everything, which proves nothing.
    const strangerId = makeId('user')
    await db
      .insertInto('users')
      .values({ id: strangerId, display_name: 'Demo Stranger' })
      .execute()
    const strangerSession = await createSession(db, strangerId, 'demo script')

    console.log(
      JSON.stringify(
        {
          token: session.token,
          strangerToken: strangerSession.token,
          strangerId,
          viewerId,
          leagueId,
          seasonId,
          homeTeamId,
          awayTeamId,
          gameId,
          videoId
        },
        null,
        2
      )
    )
  } finally {
    await db.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
