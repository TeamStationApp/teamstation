import { asPostEventsBody, type GumboPlay } from '../../../common/gumboPlay'
import { makeId } from '../../../common/ids'
import type { StoredGame } from '../../../common/scoring/session'
import { withoutNames } from '../../../common/scoring/storedNames'
import {
  asImportedWithPitches,
  AWAY_PLAYERS,
  finalGame,
  HOME_PLAYERS,
  importedThenScoredGame,
  inProgressGame,
  type Player,
  rallyGame,
  REPLAY_TEAMS,
  replaySetup
} from '../../../test/replayGameFixture'
import { postGamePlays } from '../../events/postPlays'
import { drain } from '../../statsBuilder/builder'
import { ensureGumboId, insertUser } from '../../users/insertUser'
import { seedJersey } from '../replaySeed'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/**
 * The replay seed's league (`src/server/dev/replaySeed.ts`) under ids of
 * its own, so a world never meets another on a shared stack: one season,
 * the Harbor Hawks visiting the Valley Pines, the replay fixture's game
 * stored four ways (final, in progress, imported then scored, and imported
 * whole with its pitches), the short rally game whose grand slam scores
 * three runners, and the seed's five people:
 *
 * - `team`, a member of the Pines; `scorer`, a member who keeps their score;
 * - `season`, a member of the season; `league`, a member of the league;
 * - `outsider`, who belongs to none of it.
 *
 * Each side's players are rostered with the seed's jerseys, the visitors
 * from 1 and the home side from 21.
 */
export async function runReplayLeague(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'replay-league'
  const { db, nonce } = context
  const league = makeId('league')
  const season = makeId('season')
  const away = makeId('team')
  const home = makeId('team')
  await db
    .insertInto('leagues')
    .values({ id: league, name: `Replay League ${nonce}` })
    .execute()
  await db
    .insertInto('seasons')
    .values({
      id: season,
      league_id: league,
      name: 'Replay Season',
      year: 2026,
      starts_on: '2026-01-01',
      ends_on: '2026-12-31'
    })
    .execute()
  for (const [id, name] of [
    [away, REPLAY_TEAMS.away.name],
    [home, REPLAY_TEAMS.home.name]
  ]) {
    await db.insertInto('teams').values({ id, name }).execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: season, team_id: id })
      .execute()
  }
  const gumboIds = new Map<Player, number>()
  const jerseys = new Map<Player, string>()
  for (const [side, teamId, players] of [
    ['away', away, AWAY_PLAYERS],
    ['home', home, HOME_PLAYERS]
  ] as const)
    for (const [index, player] of players.entries()) {
      const jersey = seedJersey(side, index)
      const userId = await insertUser(db, {
        display_name: `${player.first} ${player.last}`,
        first_name: player.first,
        last_name: player.last,
        bats: 'right',
        throws: 'right'
      })
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teamId,
          role: 'member',
          is_player: true,
          jersey,
          positions: player.position == null ? [] : [player.position]
        })
        .execute()
      jerseys.set(player, jersey)
      gumboIds.set(player, await ensureGumboId(db, userId))
    }

  const team = await createAccount(context, world, 'team', {
    first: 'Calder',
    last: 'Wrenfield'
  })
  const scorer = await createAccount(context, world, 'scorer', {
    first: 'Wynne',
    last: 'Halloway'
  })
  const seasonMember = await createAccount(context, world, 'season', {
    first: 'Mabry',
    last: 'Tolliver'
  })
  const leagueMember = await createAccount(context, world, 'league', {
    first: 'Wilder',
    last: 'Pennick'
  })
  const outsider = await createAccount(context, world, 'outsider', {
    first: 'Garrow',
    last: 'Linsey'
  })
  for (const account of [team, scorer])
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: account.userId,
        team_id: home,
        role: 'member'
      })
      .execute()
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: scorer.userId,
      scope_type: 'team',
      scope_id: home,
      role: 'scorekeeper'
    })
    .execute()
  await db
    .insertInto('season_members')
    .values({
      id: makeId('seasonMember'),
      user_id: seasonMember.userId,
      season_id: season
    })
    .execute()
  await db
    .insertInto('league_members')
    .values({
      id: makeId('leagueMember'),
      user_id: leagueMember.userId,
      league_id: league
    })
    .execute()

  const games = {
    finalGame: makeId('game'),
    inProgressGame: makeId('game'),
    importedThenScoredGame: makeId('game'),
    importedGame: makeId('game'),
    rallyGame: makeId('game')
  }
  for (const id of Object.values(games))
    await db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        season_id: season,
        start_at: new Date(),
        venue: 'Replay Field',
        status: 'scheduled'
      })
      .execute()

  const setup = replaySetup(player => gumboIds.get(player)!)
  for (const [player, jersey] of jerseys)
    setup.players[gumboIds.get(player)!].jersey = jersey
  // The fixture's documents name its own teams: these are this world's.
  const ours = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll(REPLAY_TEAMS.away.id, away)
        .replaceAll(REPLAY_TEAMS.home.id, home)
    ) as T
  // As the seed posts them: naming nobody, ids and structured credits only.
  // An importer following a game still being played posts live, as a
  // scorer does; one posting a game whole replaces its plays.
  const post = async (
    gameId: string,
    stored: { plays: GumboPlay[]; currentPlay: StoredGame['currentPlay'] },
    system: 'teamstation' | 'importer',
    live = system === 'teamstation'
  ): Promise<void> => {
    const plays = ours(stored.plays)
    const currentPlay = ours(stored.currentPlay)
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        plays: plays.map(play => withoutNames(play)),
        ...(live
          ? {
              currentPlay:
                currentPlay == null ? currentPlay : withoutNames(currentPlay),
              mode: 'live'
            }
          : {}),
        source: { system }
      }),
      undefined,
      undefined,
      { answer: 'all' }
    )
  }
  const final = await finalGame(setup)
  await post(games.finalGame, final, 'teamstation')
  await post(games.inProgressGame, await inProgressGame(setup), 'teamstation')
  const mixed = await importedThenScoredGame(setup)
  // The importer followed the game while it was being played, and the
  // scorer picked it up from there.
  await post(
    games.importedThenScoredGame,
    {
      plays: mixed.plays.filter(play => !('teamStation' in play)),
      currentPlay: null
    },
    'importer',
    true
  )
  await post(
    games.importedThenScoredGame,
    {
      plays: mixed.plays.filter(play => 'teamStation' in play),
      currentPlay: mixed.currentPlay
    },
    'teamstation'
  )
  await post(games.rallyGame, await rallyGame(setup), 'teamstation')
  await post(
    games.importedGame,
    { plays: final.plays.map(asImportedWithPitches), currentPlay: null },
    'importer'
  )
  await drain(db, () => new Date())
  return {
    world,
    nonce,
    accounts: {
      team,
      scorer,
      season: seasonMember,
      league: leagueMember,
      outsider
    },
    ids: {
      league,
      season,
      awayTeam: away,
      homeTeam: home,
      ...games
    }
  }
}
