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
/** Alex Lee's parent: a `guardian` link to Alex, and none to anyone else. */
export const PARENT = 306
/** Mookie Betts, a Demo Hawks player outside the game, whom the parent has no link to. */
export const MOOKIE = 7003
/** A teammate: sees the game, and may not dictate. */
export const TEAMMATE = 4001
/**
 * Mike Trout, the group fixture's account 103: a member of Spring
 * (`season_members`) who plays on no team of it.
 */
export const TROUT = 103
/** Spring's coach (a season role), who manages Spring's people. */
export const SPRING_COACH = 307

const fillers = (start: number): number[] =>
  Array.from({ length: 9 }, (_, i) => start + i)

/**
 * The people, teams and game every player name privacy pass reads, invented
 * throughout: Alex Lee of Demo Hawks, whom Spring and Fall of the league
 * Lakeshore manage and who also compete in a third season, batting against
 * Riley Chen after one pitch. Alex's parent is linked to Alex alone, and
 * Mookie Betts is on Demo Hawks' roster beside him. Mike Trout is a member
 * of Spring who plays on none of its teams, and Ryne Sandberg coaches Spring.
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
      last_name: String(id),
      // The teammate signs in: he reads the public names in the browser.
      ...(id === TEAMMATE ? { login_enabled: true } : {})
    })),
    ...(
      [
        [COACH, 'Cal Ripken'],
        [SCOREKEEPER, 'Ozzie Smith'],
        [STRANGER, 'Babe Ruth'],
        [PARENT, 'Lou Gehrig'],
        [SPRING_COACH, 'Ryne Sandberg']
      ] as const
    ).map(([id, name]) => ({
      id,
      legacyId: `usr_privacy_${id}`,
      display_name: name,
      login_enabled: true
    })),
    {
      id: MOOKIE,
      legacyId: `usr_privacy_${MOOKIE}`,
      display_name: 'Mookie Betts',
      first_name: 'Mookie',
      last_name: 'Betts'
    }
  ])
  for (const [ids, teamId] of [
    [[...hawks, MOOKIE], f.teamA],
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
  // Spring's coach manages its people, Mike Trout among them: he reads
  // Mike's full name, and may still not change it.
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      user_id: userIdOfGumbo(SPRING_COACH),
      scope_type: 'season',
      scope_id: f.seasonA,
      role: 'coach',
      granted_by: userIdOfGumbo(101),
      granted_at: new Date()
    })
    .execute()
  await db
    .insertInto('season_members')
    .values({
      id: makeId('seasonMember'),
      user_id: userIdOfGumbo(TROUT),
      season_id: f.seasonA,
      joined_at: new Date()
    })
    .execute()
  for (const id of [
    COACH,
    SCOREKEEPER,
    STRANGER,
    TEAMMATE,
    PARENT,
    SPRING_COACH
  ])
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
  await db
    .insertInto('user_links')
    .values({
      id: makeId('userLink'),
      user_id: userIdOfGumbo(PARENT),
      related_user_id: userIdOfGumbo(ALEX),
      kind: 'guardian',
      can_manage: true,
      created_at: new Date()
    })
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
