import { asPostEventsBody } from '../../../common/gumboPlay'
import { makeId } from '../../../common/ids'
import type { StoredGame } from '../../../common/scoring/session'
import { withoutNames } from '../../../common/scoring/storedNames'
import {
  AWAY_PLAYERS,
  finalGame,
  HOME_PLAYERS,
  inProgressGame,
  type Player,
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
 * The replay fixture's game, finished and in progress, as the replay seed
 * stores it (`src/server/dev/replaySeed.ts`), but under ids of its own so a
 * world never meets another on a shared stack: the Harbor Hawks visit the
 * Valley Pines in a season of their own, each side's players rostered with
 * the seed's jerseys. `team` is a member of the Pines, and `scorer` keeps
 * their score.
 *
 * The finished game is the box score's: the visitors' pitchers took the
 * mound Cole, then Gil. The game in progress is the scorer's to go on with.
 */
export async function runReplayGames(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'replay-games'
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
    first: 'Clayton',
    last: 'Kershaw'
  })
  const scorer = await createAccount(context, world, 'scorer', {
    first: 'Walker',
    last: 'Buehler'
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
  const games = { final: makeId('game'), inProgress: makeId('game') }
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
  const post = async (gameId: string, stored: StoredGame): Promise<void> => {
    const plays = ours(stored.plays)
    const currentPlay = ours(stored.currentPlay)
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        plays: plays.map(play => withoutNames(play)),
        currentPlay:
          currentPlay == null ? currentPlay : withoutNames(currentPlay),
        mode: 'live',
        source: { system: 'teamstation' }
      }),
      undefined,
      undefined,
      { answer: 'all' }
    )
  }
  await post(games.final, await finalGame(setup))
  await post(games.inProgress, await inProgressGame(setup))
  await drain(db, () => new Date())
  return {
    world,
    nonce,
    accounts: { team, scorer },
    ids: {
      league,
      season,
      awayTeam: away,
      homeTeam: home,
      finalGame: games.final,
      inProgressGame: games.inProgress
    }
  }
}
