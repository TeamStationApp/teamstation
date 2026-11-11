import { expect } from 'chai'

import { makeId } from '../common/ids'
import { userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import { atomic } from '../server/db/atomic'
import { applyPlayerAdd, recordPlayerAdd } from '../server/groups/noticePolicy'
import { actor, demoLocality, type GroupFixture } from './groupFixtures'
import { insertFixtureUsers } from './insertFixtureUsers'

/** Derek Jeter: the fixture's account 101, Lakeshore's founding administrator. */
export const DEREK = 101
/** Cal Ripken: Lakeshore's second administrator. */
export const CAL = 601
/** Barry Larkin: a plain member of Lakeshore, with no role. */
export const BARRY = 602
/** Josh Smith, of Demo Hawks. */
export const JOSH_SMITH = 603
/** Josh Staumont, of Demo Owls: his name shares Josh Smith's short form. */
export const JOSH_STAUMONT = 604
/** Ken Griffey, Josh Smith's guardian, on no level. */
export const KEN = 605
/** Tony Gwynn, Josh Staumont's guardian, on no level. */
export const TONY = 606
/** Lou Piniella, a coach of Demo Hawks, going to its practice. */
export const LOU = 607
/** Rickey Henderson, on Demo Owls only by an add his side may yet reject. */
export const RICKEY = 608
/** Dave Winfield, Rickey Henderson's guardian, on no level, who may reject the add. */
export const DAVE = 609
/** Kirby Puckett, a coach of Lakeshore's season and of no team in it. */
export const KIRBY = 610

export interface DisplayNamesWorld {
  /** Demo Owls, beside Demo Hawks (`f.teamA`) in Lakeshore's season. */
  owls: string
  /** Demo Hawks' practice, with Lou Piniella's and Josh Smith's replies. */
  practice: string
}

/**
 * The world the display names pass reads, invented throughout: the league
 * Lakeshore (the fixture's league A, now with a picture), administered by
 * Derek Jeter and Cal Ripken, with Barry Larkin a member of it and nothing
 * more; Demo Hawks and Demo Owls in its season (the fixture's season A,
 * which has no picture of its own); Josh Smith on Demo Hawks, guarded by Ken
 * Griffey, and Josh Staumont on Demo Owls, guarded by Tony Gwynn. The two
 * guardians are on no level. Lou Piniella coaches Demo Hawks and is going
 * to its practice. Rickey Henderson is on Demo Owls only by an open roster
 * add, guarded by Dave Winfield, who is on no level; Kirby Puckett coaches
 * the season and no team of it.
 *
 * Written with data writes and routes both this branch and the one before it
 * have, so the same file takes the before screenshots there.
 */
export async function seedDisplayNames(
  f: GroupFixture
): Promise<DisplayNamesWorld> {
  const { db, tokens } = f.h
  await db
    .updateTable('leagues')
    .set({ name: 'Lakeshore' })
    .where('id', '=', f.leagueA)
    .execute()
  // The harness's own team shares Demo Hawks' name; it takes another.
  await db
    .updateTable('teams')
    .set({ name: 'Demo Tigers' })
    .where('id', '=', 'tem_account')
    .execute()
  await db
    .updateTable('users')
    .set({
      display_name: 'Derek Jeter',
      first_name: 'Derek',
      last_name: 'Jeter'
    })
    .where('id', '=', userIdOfGumbo(DEREK))
    .execute()
  // An adult: the harness has him play for a team of its own, and a player
  // may not start a DM with an adult who is not his.
  await db
    .updateTable('memberships')
    .set({ is_player: false })
    .where('user_id', '=', userIdOfGumbo(DEREK))
    .execute()
  const people = [
    [CAL, 'Cal', 'Ripken', true],
    [BARRY, 'Barry', 'Larkin', true],
    [JOSH_SMITH, 'Josh', 'Smith', false],
    [JOSH_STAUMONT, 'Josh', 'Staumont', false],
    [KEN, 'Ken', 'Griffey', false],
    [TONY, 'Tony', 'Gwynn', false],
    [LOU, 'Lou', 'Piniella', false],
    [RICKEY, 'Rickey', 'Henderson', false],
    [DAVE, 'Dave', 'Winfield', true],
    [KIRBY, 'Kirby', 'Puckett', true]
  ] as const
  await insertFixtureUsers(
    db,
    people.map(([id, first, last, signsIn]) => ({
      id,
      legacyId: `usr_display_${id}`,
      display_name: `${first} ${last}`,
      first_name: first,
      last_name: last,
      ...(signsIn ? { login_enabled: true } : {})
    }))
  )
  await db
    .insertInto('scope_roles')
    .values(
      (
        [
          [CAL, 'league', f.leagueA, 'admin'],
          [LOU, 'team', f.teamA, 'coach'],
          [KIRBY, 'season', f.seasonA, 'coach']
        ] as const
      ).map(([id, scopeType, scopeId, role]) => ({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(id),
        scope_type: scopeType,
        scope_id: scopeId,
        role,
        granted_by: userIdOfGumbo(DEREK),
        granted_at: new Date()
      }))
    )
    .execute()
  await db
    .insertInto('league_members')
    .values({
      id: makeId('leagueMember'),
      user_id: userIdOfGumbo(BARRY),
      league_id: f.leagueA,
      joined_at: new Date()
    })
    .execute()
  const created = await f.h.request(
    'POST',
    '/teams',
    {
      name: 'Demo Owls',
      idempotencyKey: `display-names-owls-${Date.now()}`,
      locality: demoLocality,
      parent: { kind: 'season', id: f.seasonA }
    },
    DEREK
  )
  expect(created.status, await created.clone().text()).equals(201)
  const owls = ((await created.json()) as { id: string }).id
  await db
    .insertInto('memberships')
    .values(
      (
        [
          [JOSH_SMITH, f.teamA],
          [JOSH_STAUMONT, owls]
        ] as const
      ).map(([id, teamId]) => ({
        id: makeId('membership'),
        user_id: userIdOfGumbo(id),
        team_id: teamId,
        role: 'member' as const,
        is_player: true
      }))
    )
    .execute()
  await db
    .insertInto('user_links')
    .values(
      (
        [
          [KEN, JOSH_SMITH],
          [TONY, JOSH_STAUMONT],
          [DAVE, RICKEY]
        ] as const
      ).map(([guardian, player]) => ({
        id: makeId('userLink'),
        user_id: userIdOfGumbo(guardian),
        related_user_id: userIdOfGumbo(player),
        kind: 'guardian' as const,
        can_manage: true,
        created_at: new Date()
      }))
    )
    .execute()
  // Demo Owls adds Rickey Henderson to its roster as a coach would, which
  // tells his guardian, who may reject it for a week.
  await atomic(db, async trx => {
    const applied = await applyPlayerAdd(trx, {
      kind: 'playerAdd',
      mode: 'roster',
      userId: userIdOfGumbo(RICKEY),
      teamId: owls,
      jersey: null,
      positions: [],
      teamName: 'Demo Owls'
    })
    expect(
      await recordPlayerAdd(trx, actor(DEREK), applied, 'applied', f.clock)
    ).not.equals(null)
  })
  // The league has a picture from the catalog; its season has none.
  const picture = await f.h.request(
    'PUT',
    `/groups/league/${f.leagueA}`,
    { picture: { catalogId: 'baseball' } },
    DEREK
  )
  expect(picture.status, await picture.clone().text()).equals(200)
  // Demo Hawks' practice: its coach and a player are going.
  const practice = makeId('teamEvent')
  await db
    .insertInto('team_events')
    .values({
      id: practice,
      team_id: f.teamA,
      title: 'Practice',
      event_type: 'practice',
      start_at: new Date('2027-04-10T17:00:00Z'),
      timezone: 'UTC'
    })
    .execute()
  await db
    .insertInto('team_event_rsvps')
    .values(
      [LOU, JOSH_SMITH].map(id => ({
        event_id: practice,
        user_id: userIdOfGumbo(id),
        response: 'yes' as const,
        updated_by: userIdOfGumbo(id)
      }))
    )
    .execute()
  for (const id of [CAL, BARRY, KIRBY])
    tokens.set(
      id,
      (await createSession(db, userIdOfGumbo(id), 'display-names-fixture'))
        .token
    )
  return { owls, practice }
}
