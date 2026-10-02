import type { GumboEventType } from '../../common/gumboEventTypes'
import { asGumboPlay } from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { createSession } from '../auth/sessions'
import { makeDatabase } from '../db/database'
import { type PlayWrite, replaceGameEvents } from '../events/eventWrite'
import { rebuildAll } from '../rollups'
import { serverConfig } from '../serverConfig'

// Builds a league, two seasons, two teams, a roster, a finished game in each
// season and a video of the first, and prints tokens so the schedule, roster
// and video routes can be walked with `curl`.
//
// The first game gets three plays, written as TeamStation's own, so its line
// score and highlights have something to show. The stat rollups stay empty:
// they are sums of stat lines, and nothing here writes any.
//
//   npm run demo
//
// It refuses to run in production: it writes fictional people and would be
// nonsense in a real database.

/** The home team's players, so the roster and box score have names. */
const ROSTER = ['Robin Hale', 'Ash Berger', 'Sam Ortiz']

/** A strikeout in the top of the first, then a home run and a single. */
function demoPlays(homeTeamId: string, batters: number[]): PlayWrite[] {
  const [first, second] = batters
  const play = (
    atBatIndex: number,
    halfInning: 'top' | 'bottom',
    eventType: GumboEventType,
    homeScore: number,
    batter: number | null,
    description: string
  ): PlayWrite => ({
    gumbo: asGumboPlay({
      about: {
        atBatIndex,
        inning: 1,
        halfInning,
        isScoringPlay: eventType === 'home_run'
      },
      result: { eventType, awayScore: 0, homeScore, description },
      count: { outs: halfInning === 'top' ? 1 : 0 },
      matchup: { batter: { id: batter } },
      credits:
        batter == null ? [] : [{ teamId: homeTeamId, creditUserId: batter }]
    }),
    source: 'teamstation'
  })
  return [
    play(0, 'top', 'strikeout', 0, null, 'The leadoff batter strikes out'),
    play(1, 'bottom', 'home_run', 2, first, 'Homers to left field'),
    play(2, 'bottom', 'single', 2, second, 'Singles to right field')
  ]
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The demo script does not run in production')
  }

  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const leagueId = makeId('league')
    const seasonId = makeId('season')
    const seasonBId = makeId('season')
    const gameBId = makeId('game')
    const homeTeamId = makeId('team')
    const awayTeamId = makeId('team')
    const gameId = makeId('game')
    const videoId = makeId('video')
    const heldIds = new Set(
      (await db.selectFrom('users').select('id').execute()).map(row => row.id)
    )
    const viewer = mintUserId(id => heldIds.has(id))
    heldIds.add(viewer.userId)
    const viewerId = viewer.userId

    await db
      .insertInto('leagues')
      .values({ id: leagueId, name: 'Demo League', short_name: 'DEMO' })
      .execute()
    // Two seasons that overlap in time and share a team, which is the case a
    // career total has to get right: the same child, two sets of games.
    await db
      .insertInto('seasons')
      .values([
        {
          id: seasonId,
          league_id: leagueId,
          name: 'Demo Spring 2026',
          age_group: '11U',
          year: 2026,
          term: 'Spring'
        },
        {
          id: seasonBId,
          league_id: leagueId,
          name: 'Demo Summer 2026',
          age_group: '11U',
          year: 2026,
          term: 'Summer'
        }
      ])
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
        { season_id: seasonId, team_id: awayTeamId },
        { season_id: seasonBId, team_id: homeTeamId },
        { season_id: seasonBId, team_id: awayTeamId }
      ])
      .execute()

    // A viewer who belongs to the home team, so the access rules have work to
    // do rather than waving everything through.
    await db
      .insertInto('users')
      .values({
        id: viewerId,
        legacyId: viewer.legacyId,
        display_name: 'Demo Viewer'
      })
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
    const players: number[] = []
    for (const displayName of ROSTER) {
      const minted = mintUserId(id => heldIds.has(id))
      heldIds.add(minted.userId)
      const userId = minted.userId
      players.push(userId)
      await db
        .insertInto('users')
        .values({
          id: userId,
          legacyId: minted.legacyId,
          display_name: displayName
        })
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
        status: 'final',
        away_score: 0,
        home_score: 2,
        scoringOwner: 'teamstation'
      })
      .execute()
    await replaceGameEvents(db, {
      gameId,
      homeTeamId,
      awayTeamId,
      plays: demoPlays(homeTeamId, players)
    })

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

    // The same teams play again in the other season, so once both games have
    // stat lines a career total has two seasons to add.
    await db
      .insertInto('games')
      .values({
        id: gameBId,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        season_id: seasonBId,
        start_at: new Date(startAt.getTime() + 60 * 24 * 3600 * 1000),
        venue: 'Demo Field',
        status: 'final'
      })
      .execute()

    const rollups = await rebuildAll(db)

    // Somebody who actually batted for the home team: the first name on a
    // roster may never have come to the plate, and a demo that points at them
    // looks like the stats are broken when they are merely empty. Null until
    // the games have stat lines and the rollups are rebuilt.
    const topBatter = await db
      .selectFrom('player_season_stats')
      .select(['user_id'])
      .where('team_id', '=', homeTeamId)
      .orderBy('pa', 'desc')
      .executeTakeFirst()
    const samplePlayerId = topBatter?.user_id ?? null

    const session = await createSession(db, viewerId, 'demo script')

    // Somebody who belongs to nothing, so the access rules can be shown to
    // actually withhold rather than merely be present. Not an administrator:
    // an administrator sees everything, which proves nothing.
    const stranger = mintUserId(id => heldIds.has(id))
    heldIds.add(stranger.userId)
    const strangerId = stranger.userId
    await db
      .insertInto('users')
      .values({
        id: strangerId,
        legacyId: stranger.legacyId,
        display_name: 'Demo Stranger'
      })
      .execute()
    const strangerSession = await createSession(db, strangerId, 'demo script')

    console.log(
      JSON.stringify(
        {
          token: session.token,
          strangerToken: strangerSession.token,
          strangerId,
          viewerId,
          samplePlayerId,
          seasonBId,
          gameBId,
          rollups,
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

const entry = process.argv[1] ?? ''
if (entry.endsWith('/demo.ts') || entry.endsWith('/demo.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
