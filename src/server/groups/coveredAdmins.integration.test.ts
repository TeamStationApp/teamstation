import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { GroupRef } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import type { PlayerAddTerms } from '../../common/notifications'
import { userIdOfGumbo } from '../../common/userId'
import { migration123CoveredAdmins } from '../../migrate/migrations/123coveredAdmins'
import {
  actor,
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { closeInto } from '../admin/people'
import { audienceOf } from '../chat/audiences'
import { isApprover, moderatorsOf } from '../chat/listing'
import { atomic } from '../db/atomic'
import { setScopeRoles } from '../invites/people'
import { createTeam } from '../teams/createTeam'
import { directAdminIds, effectiveAdminIds } from './adminGuard'
import { inheritedAdminIds } from './inheritedAdmins'
import { playerAddApprovers, recordPlayerAdd } from './noticePolicy'
import { applyParents, previewParents } from './relationships'

describe('covered group administrators', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const ref = (kind: GroupRef['kind'], id: string): GroupRef => ({ kind, id })
  async function create(
    kind: GroupRef['kind'],
    parent?: GroupRef,
    user = 101
  ): Promise<string> {
    const response = await f.h.request(
      'POST',
      `/${kind === 'team' ? 'teams' : kind === 'season' ? 'seasons' : 'leagues'}`,
      {
        name: 'Demo Covered Group',
        idempotencyKey: makeId('team'),
        locality: demoLocality,
        startsOn: '2027-03-01',
        endsOn: '2027-05-31',
        timezone: 'UTC',
        parent
      },
      user
    )
    expect(response.status, await response.clone().text()).equals(201)
    return ((await response.json()) as { id: string }).id
  }
  async function grant(
    kind: GroupRef['kind'],
    id: string,
    user: number
  ): Promise<void> {
    await setScopeRoles(
      f.h.db,
      kind,
      id,
      userIdOfGumbo(user),
      { admin: true, flags: [] },
      userIdOfGumbo(105)
    )
  }
  it('omits covered fresh grants, preserves standalone and site-only grants, and retains parent access', async () => {
    const season = await create('season', ref('league', f.leagueA))
    const team = await create('team', ref('season', season))
    for (const group of [ref('season', season), ref('team', team)]) {
      expect(await directAdminIds(f.h.db, group)).deep.equals([])
      expect(await inheritedAdminIds(f.h.db, group)).deep.equals([
        userIdOfGumbo(101)
      ])
    }
    for (const group of [
      ref('team', await create('team')),
      ref('season', await create('season'))
    ])
      expect(await directAdminIds(f.h.db, group)).deep.equals([
        userIdOfGumbo(101)
      ])
    const siteTeam = await create('team', ref('season', season), 105)
    expect(await directAdminIds(f.h.db, ref('team', siteTeam))).deep.equals([
      userIdOfGumbo(105)
    ])
    expect(
      (await f.h.request('GET', `/manage/team/${team}`, undefined, 101)).status
    ).equals(200)
  })
  it('allows self step-down and leave with inherited coverage, but refuses a standalone last admin', async () => {
    expect(
      (
        await f.h.request(
          'DELETE',
          `/me/groups/team/${f.teamA}/roles/admin`,
          undefined,
          101
        )
      ).status
    ).equals(200)
    expect(await directAdminIds(f.h.db, ref('team', f.teamA))).deep.equals([])
    await grant('team', f.teamA, 106)
    expect(
      (
        await f.h.request(
          'DELETE',
          `/me/groups/team/${f.teamA}`,
          undefined,
          106
        )
      ).status
    ).equals(200)
    expect(
      (
        await f.h.request(
          'DELETE',
          `/me/groups/team/${f.standaloneTeam}/roles/admin`,
          undefined,
          103
        )
      ).status
    ).equals(409)
    expect(
      await directAdminIds(f.h.db, ref('team', f.standaloneTeam))
    ).deep.equals([userIdOfGumbo(103)])
  })
  it('counts only direct team administrators before cutover, for leaving and scheduling', async () => {
    await f.h.db
      .updateTable('system_settings')
      .set({ value: false })
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    // Team A competes in league B's tournament, which administers it only
    // until the cutover chooses its parent.
    await f.h.db
      .insertInto('season_teams')
      .values({ team_id: f.teamA, season_id: f.seasonB })
      .execute()
    await grant('team', f.teamA, 106)
    await f.h.db
      .deleteFrom('scope_roles')
      .where('scope_id', '=', f.teamA)
      .where('user_id', '=', userIdOfGumbo(101))
      .execute()
    expect(await inheritedAdminIds(f.h.db, ref('team', f.teamA))).includes(
      userIdOfGumbo(102)
    )
    expect(
      (
        await f.h.request(
          'DELETE',
          `/me/groups/team/${f.teamA}/roles/admin`,
          undefined,
          106
        )
      ).status
    ).equals(409)
    const gameId = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.standaloneTeam,
        season_id: f.seasonA,
        start_at: new Date('2027-03-01T12:00:00Z')
      })
      .execute()
    expect(
      (
        await f.h.request(
          'PUT',
          `/games/${gameId}/field`,
          { fenceDistanceFt: 210 },
          102
        )
      ).status
    ).equals(403)
  })
  it('ignores inactive organizational admins and site-only status', async () => {
    await f.h.db
      .deleteFrom('scope_roles')
      .where('scope_id', 'in', [f.teamA, f.seasonA])
      .execute()
    const group = ref('team', f.teamA)
    for (const state of [
      { login_enabled: false },
      { login_enabled: true, disabled_at: new Date() },
      { disabled_at: null, merged_into: userIdOfGumbo(104) }
    ]) {
      await f.h.db
        .updateTable('users')
        .set(state)
        .where('id', '=', userIdOfGumbo(101))
        .execute()
      expect(await effectiveAdminIds(f.h.db, group)).deep.equals([])
    }
    await f.h.db
      .updateTable('users')
      .set({ merged_into: null })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    expect(await effectiveAdminIds(f.h.db, group)).deep.equals([
      userIdOfGumbo(101)
    ])
  })
  it('uses legacy season membership only before cutover, grants site-admin teams until then, and keeps all owner memberships', async () => {
    for (const ready of [false, true]) {
      await f.h.db
        .updateTable('system_settings')
        .set({ value: ready })
        .where('key', '=', 'creation.hierarchyReady')
        .execute()
      const team = await createTeam(
        f.h.db,
        { name: 'Demo Legacy', externalIds: [], season: { id: f.seasonA } },
        { userId: userIdOfGumbo(101), isAdmin: false }
      )
      expect(await inheritedAdminIds(f.h.db, ref('team', team.id))).deep.equals(
        ready ? [] : [userIdOfGumbo(101)]
      )
      const grants = await f.h.db
        .selectFrom('scope_roles')
        .select('id')
        .where('scope_id', '=', team.id)
        .execute()
      expect(grants).length(ready ? 1 : 0)
      // A site administrator gets no owner membership, so the cutover could
      // strand their team: it keeps the grant until then.
      const siteTeam = await createTeam(
        f.h.db,
        {
          name: 'Demo Site Legacy',
          externalIds: [],
          season: { id: f.seasonA }
        },
        { userId: userIdOfGumbo(105), isAdmin: true }
      )
      expect(
        await directAdminIds(f.h.db, ref('team', siteTeam.id))
      ).deep.equals([userIdOfGumbo(105)])
      expect(
        await f.h.db
          .selectFrom('memberships')
          .select('role')
          .where('team_id', '=', team.id)
          .execute()
      ).deep.equals([{ role: 'owner' }])
      const freshSeason = await createTeam(
        f.h.db,
        {
          name: 'Demo New Season Team',
          externalIds: [],
          season: { name: `Demo Created ${ready}`, year: 2027 }
        },
        { userId: userIdOfGumbo(103), isAdmin: false }
      )
      expect(
        await f.h.db
          .selectFrom('scope_roles')
          .select('id')
          .where('scope_id', '=', freshSeason.id)
          .execute()
      ).length(ready ? 1 : 0)
    }
  })
  it('refuses a hierarchy detach that strands a group, but permits a complete covered move', async () => {
    const team = await create('team', ref('season', f.seasonA))
    const actions = [
      {
        child: ref('team', team),
        parent: ref('league', f.leagueA),
        operation: 'detach' as const
      }
    ]
    const detached = await previewParents(f.h.db, actions)
    const refused = await applyParents(f.h.db, [actor(101)], detached).catch(
      (e: unknown) => e
    )
    expect(refused).property('code', 'conflict')
    expect(refused)
      .property('message')
      .contains('its parent link carried their authority')
    expect(await inheritedAdminIds(f.h.db, ref('team', team))).deep.equals([
      userIdOfGumbo(101)
    ])
    const move = await previewParents(f.h.db, [
      ...actions,
      {
        child: ref('team', team),
        parent: ref('season', f.seasonB),
        operation: 'attach'
      }
    ])
    await applyParents(f.h.db, [actor(101), actor(102)], move)
    expect(await inheritedAdminIds(f.h.db, ref('team', team))).deep.equals([
      userIdOfGumbo(102)
    ])
  })
  it('preserves inherited-only seasons and descendant teams through a complete league move', async () => {
    const season = await create('season', ref('league', f.leagueA))
    const team = await create('team', ref('season', season))
    const detach = {
      child: ref('season', season),
      parent: ref('league', f.leagueA),
      operation: 'detach' as const
    }
    expect(
      await applyParents(
        f.h.db,
        [actor(101)],
        await previewParents(f.h.db, [detach])
      ).catch((e: unknown) => e)
    ).property('code', 'conflict')
    const move = await previewParents(f.h.db, [
      detach,
      {
        child: ref('season', season),
        parent: ref('league', f.leagueB),
        operation: 'attach'
      },
      {
        child: ref('team', team),
        parent: ref('league', f.leagueA),
        operation: 'detach'
      },
      {
        child: ref('team', team),
        parent: ref('season', season),
        operation: 'attach'
      }
    ])
    await applyParents(f.h.db, [actor(101), actor(102)], move)
    for (const group of [ref('season', season), ref('team', team)]) {
      expect(await directAdminIds(f.h.db, group)).deep.equals([])
      expect(await inheritedAdminIds(f.h.db, group)).deep.equals([
        userIdOfGumbo(102)
      ])
    }
  })
  it('deletes an account with surviving inherited coverage and refuses to count its own ancestor roles', async () => {
    await f.h.db
      .deleteFrom('scope_roles')
      .where('scope_id', '=', f.teamA)
      .execute()
    await grant('team', f.teamA, 106)
    expect(
      (await f.h.request('DELETE', '/me/account', undefined, 106)).status
    ).equals(204)
    expect(await effectiveAdminIds(f.h.db, ref('team', f.teamA))).deep.equals([
      userIdOfGumbo(101)
    ])
    expect(
      (await f.h.request('DELETE', '/me/account', undefined, 101)).status
    ).equals(409)
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .select('login_enabled')
          .where('id', '=', userIdOfGumbo(101))
          .executeTakeFirstOrThrow()
      ).login_enabled
    ).equals(true)
  })
  it('permits closing a direct admin covered by a different parent administrator', async () => {
    await f.h.db
      .deleteFrom('scope_roles')
      .where('scope_id', '=', f.teamA)
      .execute()
    await grant('team', f.teamA, 106)
    expect(
      (await closeInto(f.h.db, userIdOfGumbo(106), userIdOfGumbo(104))).closed
    ).equals(true)
    expect(await effectiveAdminIds(f.h.db, ref('team', f.teamA))).deep.equals([
      userIdOfGumbo(101)
    ])
  })
  it('keeps a team chat moderator whose coach grant is on an account merged into theirs', async () => {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(106),
        scope_type: 'team',
        scope_id: f.teamA,
        role: 'coach',
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    expect(
      (await closeInto(f.h.db, userIdOfGumbo(106), userIdOfGumbo(104))).closed
    ).equals(true)
    const conversation = { kind: 'teamMembers' as const, scope_id: f.teamA }
    expect(
      await moderatorsOf(f.h.db, conversation, [
        userIdOfGumbo(104),
        userIdOfGumbo(103)
      ])
    ).deep.equals(new Set([userIdOfGumbo(104)]))
  })
  for (const fresh of [false, true]) {
    for (const owner of [false, true]) {
      it(`preserves player-add stand-ins and notices (fresh=${fresh}, owner=${owner})`, async () => {
        const db = f.h.db
        const teamId = fresh
          ? await create('team', ref('season', f.seasonA))
          : f.teamA
        const userId = userIdOfGumbo(101)
        await insertFixtureUsers(db, {
          id: 107,
          display_name: 'Tony Kemp',
          first_name: 'Tony',
          last_name: 'Kemp',
          login_enabled: false
        })
        const playerId = userIdOfGumbo(107)
        await db
          .insertInto('memberships')
          .values({
            id: makeId('membership'),
            user_id: playerId,
            team_id: teamId,
            role: 'member',
            is_player: true
          })
          .execute()
        if (owner)
          await db
            .insertInto('memberships')
            .values({
              id: makeId('membership'),
              user_id: userId,
              team_id: teamId,
              role: 'owner'
            })
            .execute()
        // Competition membership does not grant the other season's administrator a say.
        await db
          .insertInto('season_teams')
          .values({
            team_id: teamId,
            season_id: f.seasonB
          })
          .execute()
        const terms: PlayerAddTerms = {
          kind: 'playerAdd',
          mode: 'roster',
          userId: playerId,
          teamId: f.teamB,
          teamName: 'Demo Team',
          jersey: null,
          positions: []
        }
        const record = async (): Promise<string> => {
          const id = await atomic(
            db,
            async trx =>
              await recordPlayerAdd(trx, actor(102), terms, 'pending', f.clock)
          )
          expect(id).not.equals(null)
          return id!
        }
        const before = await record()
        const pending = await record()
        expect(
          (
            await f.h.request(
              'POST',
              `/relationship-requests/${before}/decline`,
              {},
              101
            )
          ).status
        ).equals(200)
        await db.transaction().execute(async trx => {
          await sql.raw(migration123CoveredAdmins.up).execute(trx)
        })
        expect(await playerAddApprovers(db, playerId, f.teamB)).deep.equals({
          userIds: [userId],
          standIn: true,
          told: 'coaches'
        })
        expect(
          (
            await f.h.request(
              'POST',
              `/relationship-requests/${pending}/decline`,
              {},
              105
            )
          ).status
        ).equals(403)
        expect(
          (
            await f.h.request(
              'POST',
              `/relationship-requests/${pending}/decline`,
              {},
              101
            )
          ).status
        ).equals(200)
        const after = await record()
        expect(
          await db
            .selectFrom('notification_events')
            .select('recorded_recipients')
            .where('source_id', '=', after)
            .executeTakeFirstOrThrow()
        )
          .property('recorded_recipients')
          .deep.equals([userIdOfGumbo(102), userId])
        expect(
          (
            await f.h.request(
              'POST',
              `/relationship-requests/${after}/accept`,
              {},
              101
            )
          ).status
        ).equals(200)
        const notice = await atomic(
          db,
          async trx =>
            await recordPlayerAdd(trx, actor(104), terms, 'applied', f.clock)
        )
        expect(notice).not.equals(null)
        expect(
          (
            await f.h.request(
              'POST',
              `/relationship-requests/${notice}/decline`,
              {},
              101
            )
          ).status
        ).equals(200)
        expect(
          await db
            .selectFrom('notification_events')
            .select('recorded_recipients')
            .where('source_id', '=', notice!)
            .where('source_type', '=', 'playerAddRejected')
            .executeTakeFirstOrThrow()
        )
          .property('recorded_recipients')
          .deep.equals([userIdOfGumbo(104), userIdOfGumbo(102)])
      })
    }

    it(`preserves exhibition fields and chat moderation without a direct grant (fresh=${fresh})`, async () => {
      const teamId = fresh
        ? await create('team', ref('season', f.seasonA))
        : f.teamA
      const userId = userIdOfGumbo(101)
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: teamId,
          role: 'member'
        })
        .execute()
      // Competition alone must not make the other league's admin, or a coach
      // of the season the team only competes in, a moderator.
      await f.h.db
        .insertInto('season_teams')
        .values({ team_id: teamId, season_id: f.seasonB })
        .execute()
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(106),
          scope_type: 'season',
          scope_id: f.seasonB,
          role: 'coach',
          granted_by: userIdOfGumbo(105)
        })
        .execute()
      const gameId = makeId('game')
      await f.h.db
        .insertInto('games')
        .values({
          id: gameId,
          home_team_id: teamId,
          away_team_id: f.standaloneTeam,
          season_id: null,
          start_at: new Date('2027-03-01T12:00:00Z')
        })
        .execute()
      const conversation = { kind: 'teamMembers' as const, scope_id: teamId }
      async function check(distance: number): Promise<void> {
        expect(
          (await audienceOf(f.h.db, 'teamMembers', teamId, new Date())).has(
            userId
          )
        ).equals(true)
        expect(
          await moderatorsOf(f.h.db, conversation, [
            userId,
            userIdOfGumbo(102),
            userIdOfGumbo(106)
          ])
        ).deep.equals(new Set([userId]))
        expect(await isApprover(f.h.db, conversation, userId)).equals(true)
        const response = await f.h.request(
          'PUT',
          `/games/${gameId}/field`,
          { fenceDistanceFt: distance },
          101
        )
        expect(response.status, await response.clone().text()).equals(200)
        expect(
          await f.h.db
            .selectFrom('games')
            .select('fence_distance_ft')
            .where('id', '=', gameId)
            .executeTakeFirstOrThrow()
        ).property('fence_distance_ft', distance)
      }
      await check(200)
      await f.h.db.transaction().execute(async trx => {
        await sql.raw(migration123CoveredAdmins.up).execute(trx)
      })
      expect(await directAdminIds(f.h.db, ref('team', teamId))).deep.equals([])
      await check(210)
    })
  }
})
