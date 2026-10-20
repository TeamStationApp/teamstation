import { userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import type { GroupFixture } from './groupFixtures'
import { insertFixtureUsers } from './insertFixtureUsers'

/** Invented/MLB-only people shared by before/after browser proofs. */
export async function seedEventInfo2People(
  f: GroupFixture,
  gameId: string
): Promise<void> {
  for (const [id, name] of [
    [107, 'Tony Gwynn'],
    [108, 'Mookie Betts'],
    [109, 'Ken Griffey'],
    [110, 'Reggie Jackson'],
    [112, 'Cal Ripken'],
    [113, 'Willie Mays'],
    [114, 'Roberto Clemente'],
    [115, 'Alex Rodriguez']
  ] as const) {
    await insertFixtureUsers(f.h.db, {
      id,
      legacyId: `usr_info2_${id}`,
      display_name: name,
      first_name: name.split(' ')[0],
      last_name: name.split(' ').slice(1).join(' '),
      login_enabled: true
    })
    f.h.tokens.set(
      id,
      (await createSession(f.h.db, userIdOfGumbo(id), 'event-info-fixture'))
        .token
    )
  }
  await f.h.db
    .updateTable('users')
    .set({ bats: 'switch', throws: 'right' })
    .where('id', 'in', [
      userIdOfGumbo(103),
      userIdOfGumbo(104),
      userIdOfGumbo(108),
      userIdOfGumbo(113),
      userIdOfGumbo(114)
    ])
    .execute()
  await f.h.db
    .updateTable('memberships')
    .set({ positions: ['SS', 'CF'], jersey: '8' })
    .where('team_id', '=', f.teamA)
    .where('user_id', 'in', [userIdOfGumbo(103), userIdOfGumbo(104)])
    .execute()
  for (const id of [107, 108, 112, 113, 114])
    await f.h.db
      .insertInto('memberships')
      .values({
        id: `mem_info2_${id}`,
        team_id: f.teamA,
        user_id: userIdOfGumbo(id),
        is_player: [108, 113, 114].includes(id),
        positions: [108, 113, 114].includes(id) ? ['SS', 'CF'] : [],
        jersey: [108, 113, 114].includes(id) ? '12' : null
      })
      .execute()
  for (const id of [106, 108])
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: `role_info2_${id}`,
        user_id: userIdOfGumbo(id),
        scope_type: 'team',
        scope_id: f.teamA,
        role: 'coach'
      })
      .execute()
  await f.h.db
    .insertInto('user_links')
    .values([
      {
        id: 'link_info2_guardian',
        user_id: userIdOfGumbo(105),
        related_user_id: userIdOfGumbo(103),
        kind: 'guardian',
        can_manage: false
      },
      {
        id: 'link_info2_outside',
        user_id: userIdOfGumbo(101),
        related_user_id: userIdOfGumbo(115),
        kind: 'guardian',
        can_manage: false
      }
    ])
    .execute()
  await f.h.db
    .insertInto('season_members')
    .values({
      id: 'member_info2_season',
      user_id: userIdOfGumbo(109),
      season_id: f.seasonA
    })
    .execute()
  await f.h.db
    .insertInto('league_members')
    .values({
      id: 'member_info2_league',
      user_id: userIdOfGumbo(110),
      league_id: f.leagueA
    })
    .execute()
  for (const [id, response] of [
    [105, 'maybe'],
    [106, 'yes'],
    [107, 'no'],
    [108, 'yes'],
    [109, 'yes'],
    [110, 'no'],
    [114, 'maybe']
  ] as const)
    await f.h.db
      .insertInto('game_rsvps')
      .values({
        event_id: gameId,
        user_id: userIdOfGumbo(id),
        response,
        updated_by: userIdOfGumbo(id)
      })
      .execute()
}
