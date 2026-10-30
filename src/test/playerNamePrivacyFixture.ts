import { makeId } from '../common/ids'
import { newSetup, type RosterPlayer } from '../common/scoring/lineup'
import { type EventStore, ScoringSession } from '../common/scoring/session'
import { asGumboId, userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import { readPlays } from '../server/events/postPlays'
import type { GroupFixture } from './groupFixtures'
import { insertFixtureUsers } from './insertFixtureUsers'
import { addGame } from './scoreboardKit'

export const COACH = 303
export const SCOREKEEPER = 304
export const STRANGER = 305
/** A teammate: sees the game, and may not dictate. */
export const TEAMMATE = 4001

const fillers = (start: number): number[] =>
  Array.from({ length: 9 }, (_, i) => start + i)

/**
 * The people, teams and game every player name privacy pass reads, invented
 * throughout: Alex Lee of Demo Hawks, whom Spring and Fall of the league
 * Lakeshore manage and who also compete in a third season, batting against
 * Riley Chen after one pitch.
 */
export async function seedPrivacyGame(
  f: GroupFixture
): Promise<{ ALEX: number; RILEY: number; gameId: string }> {
  const { db, tokens } = f.h
  await db
    .updateTable('leagues')
    .set({ name: 'Lakeshore' })
    .where('id', '=', f.leagueA)
    .execute()
  await db
    .updateTable('seasons')
    .set({ name: 'Spring' })
    .where('id', '=', f.seasonA)
    .execute()
  await db
    .updateTable('seasons')
    .set({ name: 'Fall' })
    .where('id', '=', f.playoffs)
    .execute()
  await db
    .insertInto('season_team_parents')
    .values({ season_id: f.playoffs, team_id: f.teamA })
    .execute()
  // A season Demo Hawks only competes in, which must contribute nothing.
  await db
    .insertInto('season_teams')
    .values({ season_id: f.seasonB, team_id: f.teamA })
    .execute()
  const hawks = fillers(4000)
  const eagles = fillers(4100)
  await insertFixtureUsers(db, [
    ...[...hawks, ...eagles].map(id => ({
      id,
      legacyId: `usr_privacy_${id}`,
      display_name: `Filler ${id}`,
      first_name: 'Filler',
      last_name: String(id)
    })),
    ...(
      [
        [COACH, 'Cal Ripken'],
        [SCOREKEEPER, 'Ozzie Smith'],
        [STRANGER, 'Babe Ruth']
      ] as const
    ).map(([id, name]) => ({
      id,
      legacyId: `usr_privacy_${id}`,
      display_name: name,
      login_enabled: true
    }))
  ])
  for (const [ids, teamId] of [
    [hawks, f.teamA],
    [eagles, f.teamB]
  ] as const)
    await db
      .insertInto('memberships')
      .values(
        ids.map(id => ({
          id: makeId('membership'),
          user_id: userIdOfGumbo(id),
          team_id: teamId,
          role: 'member' as const,
          is_player: true
        }))
      )
      .execute()
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: userIdOfGumbo(COACH),
      team_id: f.teamA,
      role: 'member',
      is_player: false
    })
    .execute()
  for (const [id, role] of [
    [COACH, 'coach'],
    [SCOREKEEPER, 'scorekeeper']
  ] as const)
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(id),
        scope_type: 'team',
        scope_id: f.teamA,
        role,
        granted_by: userIdOfGumbo(101),
        granted_at: new Date()
      })
      .execute()
  for (const id of [COACH, SCOREKEEPER, STRANGER, TEAMMATE])
    tokens.set(
      id,
      (await createSession(db, userIdOfGumbo(id), 'privacy-fixture')).token
    )
  // The batter and the pitcher of the fixture's one pitch: Demo Hawks away.
  const teams = {
    away: { id: f.teamA, name: 'Demo Hawks', logoUrl: null },
    home: { id: f.teamB, name: 'Demo Eagles', logoUrl: null }
  }
  const rows = (ids: number[]): RosterPlayer[] =>
    ids.map(id => ({
      userId: userIdOfGumbo(id),
      gumboId: asGumboId(id),
      shortName: ''
    }))
  const setup = newSetup(teams, { away: rows(hawks), home: rows(eagles) })
  const ALEX = setup.sides.away.battingOrder[0]
  const RILEY = setup.sides.home.defense.P!
  for (const [id, first, last] of [
    [ALEX, 'Alex', 'Lee'],
    [RILEY, 'Riley', 'Chen']
  ] as const)
    await db
      .updateTable('users')
      .set({
        display_name: `${first} ${last}`,
        first_name: first,
        last_name: last
      })
      .where('id', '=', userIdOfGumbo(id))
      .execute()
  const gameId = await addGame(db, {
    homeTeamId: f.teamB,
    awayTeamId: f.teamA,
    startAt: new Date(),
    status: 'inProgress'
  })
  const load: EventStore['load'] = async id => {
    const game = await db
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return {
      plays: (await readPlays(db, id)).map(row => row.gumbo as never),
      currentPlay: game.currentPlay as never
    }
  }
  const session = await ScoringSession.open(
    {
      load,
      save: async (id, change) => {
        const answer = await f.h.request(
          'POST',
          `/games/${id}/events`,
          { ...change, mode: 'live', source: { system: 'teamstation' } },
          SCOREKEEPER
        )
        if (!answer.ok) throw new Error(await answer.text())
        return await load(id)
      }
    },
    gameId,
    { gamePk: gameId, teams, setup }
  )
  session.apply({ type: 'pitch', call: 'B' })
  await session.flush()
  // A box score reads what only the stats builder writes.
  await db
    .insertInto('game_player_stats')
    .values(
      [
        [ALEX, f.teamA],
        [RILEY, f.teamB]
      ].map(([id, teamId]) => ({
        id: makeId('gamePlayerStats'),
        game_id: gameId,
        gumbo_id: id as number,
        team_id: teamId as string,
        pa: 1,
        ab: 1,
        h: 1,
        singles: 1
      }))
    )
    .execute()

  return { ALEX, RILEY, gameId }
}
