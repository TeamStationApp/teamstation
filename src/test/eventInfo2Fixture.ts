import { createSession } from '../server/auth/sessions'
import type { GroupFixture } from './groupFixtures'

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
    await f.h.db
      .insertInto('users')
      .values({
        id,
        legacyId: `usr_info2_${id}`,
        display_name: name,
        first_name: name.split(' ')[0],
        last_name: name.split(' ').slice(1).join(' '),
        login_enabled: true
      })
      .execute()
    f.h.tokens.set(
      id,
      (await createSession(f.h.db, id, 'event-info-fixture')).token
    )
  }
  await f.h.db
    .updateTable('users')
    .set({ bats: 'switch', throws: 'right' })
    .where('id', 'in', [103, 104, 108, 113, 114])
    .execute()
  await f.h.db
    .updateTable('memberships')
    .set({ positions: ['SS', 'CF'], jersey: '8' })
    .where('team_id', '=', f.teamA)
    .where('user_id', 'in', [103, 104])
    .execute()
  for (const id of [107, 108, 112, 113, 114])
    await f.h.db
      .insertInto('memberships')
      .values({
        id: `mem_info2_${id}`,
        team_id: f.teamA,
        user_id: id,
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
        user_id: id,
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
        user_id: 105,
        related_user_id: 103,
        kind: 'guardian',
        can_manage: false
      },
      {
        id: 'link_info2_outside',
        user_id: 101,
        related_user_id: 115,
        kind: 'guardian',
        can_manage: false
      }
    ])
    .execute()
  await f.h.db
    .insertInto('season_members')
    .values({ id: 'member_info2_season', user_id: 109, season_id: f.seasonA })
    .execute()
  await f.h.db
    .insertInto('league_members')
    .values({ id: 'member_info2_league', user_id: 110, league_id: f.leagueA })
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
      .values({ event_id: gameId, user_id: id, response, updated_by: id })
      .execute()
}
