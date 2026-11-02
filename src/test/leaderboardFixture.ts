import { userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import type { GroupFixture } from './groupFixtures'
import { insertFixtureUsers } from './insertFixtureUsers'

/** Twelve umpires, with twelve games down to one, the first six of them final. */
export const LEADERBOARD_RANKED = [
  'Hank Aaron',
  'Ernie Banks',
  'Roberto Clemente',
  'Joe DiMaggio',
  'Bob Feller',
  'Lou Gehrig',
  'Rogers Hornsby',
  'Reggie Jackson',
  'Al Kaline',
  'Sandy Koufax',
  'Mickey Mantle',
  'Willie Mays'
].map((name, i) => ({ id: 201 + i, name, games: 12 - i }))
/** A league umpire who has worked no game. */
export const LEADERBOARD_IDLE = { id: 213, name: 'Jackie Robinson' }

/** Adds both to an `umpireFixture` league; each can sign in, and none administers it. */
export async function seedLeaderboard(f: GroupFixture): Promise<void> {
  const people = [...LEADERBOARD_RANKED, LEADERBOARD_IDLE]
  for (const { id, name } of people) {
    await insertFixtureUsers(f.h.db, {
      id,
      legacyId: `usr_board_${id}`,
      display_name: name,
      first_name: name.split(' ')[0],
      last_name: name.split(' ')[1],
      login_enabled: true,
      email: `board${id}@example.com`,
      emailId: `email_board_${id}`
    })
    f.h.tokens.set(
      id,
      (await createSession(f.h.db, userIdOfGumbo(id), 'board-fixture')).token
    )
  }
  await f.h.db
    .insertInto('league_umpires')
    .values(
      people.map(({ id }) => ({
        league_id: f.leagueA,
        user_id: userIdOfGumbo(id),
        granted_by: userIdOfGumbo(101)
      }))
    )
    .execute()
  const games = Array.from({ length: 12 }, (_, i) => ({
    id: `gam_board_${i}`,
    home_team_id: f.teamB,
    away_team_id: f.standaloneTeam,
    season_id: f.seasonA,
    start_at: new Date('2027-03-01T12:00:00Z'),
    status: i < 6 ? ('final' as const) : ('scheduled' as const)
  }))
  await f.h.db.insertInto('games').values(games).execute()
  await f.h.db
    .insertInto('umpire_assignments')
    .values(
      LEADERBOARD_RANKED.flatMap(({ id, games: count }, slot) =>
        games.slice(0, count).map(game => ({
          game_id: game.id,
          slot: `uty_plate:${slot + 1}`,
          user_id: userIdOfGumbo(id),
          assigned_by: userIdOfGumbo(101)
        }))
      )
    )
    .execute()
}
