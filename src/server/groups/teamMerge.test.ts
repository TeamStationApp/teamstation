import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { actor } from '../../test/groupFixtures'
import { mergeTeams } from '../admin/mergeTeams'
import { withdrawFromGame } from '../schedule/gameApprovals'
import { mergeParents } from './teamMerge'

describe('parent-safe team identity merging', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  async function rejects(work: Promise<unknown>, code: string): Promise<void> {
    let error: unknown
    try {
      await work
    } catch (caught) {
      error = caught
    }
    expect(error).property('code', code)
  }
  for (const duplicate of [false, true])
    it(`preserves withdrawal and approved references through identity merging${duplicate ? ' with a richer duplicate fixture' : ''}`, async () => {
      const stub = 'withdrawMergeExternal'
      await f.h.db
        .insertInto('teams')
        .values({
          id: stub,
          name: 'Demo Duplicate Opponent',
          kind: 'external',
          custodian_type: 'season',
          custodian_id: f.seasonB
        })
        .execute()
      const startAt = '2029-07-01T19:00:00.000Z'
      const sent = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'season', id: f.seasonB },
          game: {
            homeTeamId: f.teamB,
            awayTeamId: stub,
            seasonId: f.seasonB,
            startAt,
            venue: null,
            outsideTournament: null,
            status: 'scheduled'
          },
          idempotencyKey: 'merge-withdrawal-game'
        },
        102
      )
      const request = (await sent.json()) as { id: string; gameId: string }
      expect(sent.status).equals(201)
      const withdrawn = await withdrawFromGame(
        f.h.db,
        actor(102),
        request.gameId,
        stub,
        f.clock
      )
      if (duplicate)
        await f.h.db
          .insertInto('games')
          .values({
            id: 'richCanonical',
            home_team_id: f.teamB,
            away_team_id: f.teamA,
            season_id: f.seasonB,
            start_at: new Date(startAt),
            status: 'final',
            home_score: 3,
            away_score: 2
          })
          .execute()
      await mergeTeams(f.h.db, {
        fromTeamId: stub,
        intoTeamId: f.teamA,
        apply: true
      })
      const id = duplicate ? 'richCanonical' : request.gameId
      const retained = await f.h.db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(retained.status).equals('cancelled')
      expect(retained.cancellation_reason).equals('withdrawal')
      expect(retained.withdrawn_by_team_id).equals(f.teamA)
      expect(retained.withdrawn_by_user_id).equals(userIdOfGumbo(102))
      expect(retained.withdrawn_at!.getTime()).equals(
        withdrawn.withdrawn_at!.getTime()
      )
      expect(
        (
          await f.h.db
            .selectFrom('group_requests')
            .select('game_id')
            .where('id', '=', request.id)
            .executeTakeFirstOrThrow()
        ).game_id
      ).equals(id)
      if (duplicate) {
        expect(retained.home_score).equals(3)
        expect(retained.away_score).equals(2)
      }
    })
  it('refuses conflicting lineages, merging a full team into a placeholder and creating a self opponent', async () => {
    await rejects(
      mergeTeams(f.h.db, {
        fromTeamId: f.teamA,
        intoTeamId: f.teamB,
        apply: true
      }),
      'conflict'
    )
    await f.h.db
      .insertInto('teams')
      .values({
        id: 'mergeExternal',
        name: 'Demo External',
        kind: 'external',
        custodian_type: 'season',
        custodian_id: f.seasonB
      })
      .execute()
    await rejects(mergeParents(f.h.db, f.teamA, 'mergeExternal'), 'conflict')
    await f.h.db
      .insertInto('games')
      .values({
        id: 'selfOpponent',
        home_team_id: 'mergeExternal',
        away_team_id: f.teamA,
        start_at: new Date()
      })
      .execute()
    await rejects(mergeParents(f.h.db, 'mergeExternal', f.teamA), 'conflict')
    await rejects(mergeParents(f.h.db, 'missing', f.teamA), 'notFound')
    expect(
      (
        await f.h.db
          .selectFrom('teams')
          .select('merged_into')
          .where('id', '=', f.teamA)
          .executeTakeFirstOrThrow()
      ).merged_into
    ).equals(null)
  })
  it('unions compatible parents, direct roles and overlapping active competition without dropping administration', async () => {
    const response = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Same Identity',
        locality: demoLocality,
        parent: { kind: 'season', id: f.playoffs },
        idempotencyKey: 'compatible-merge-team'
      },
      101
    )
    const into = ((await response.json()) as { id: string }).id
    await f.h.db
      .insertInto('memberships')
      .values([
        {
          id: 'mergeOwner',
          user_id: userIdOfGumbo(101),
          team_id: f.teamA,
          role: 'owner'
        },
        {
          id: 'mergeMember',
          user_id: userIdOfGumbo(101),
          team_id: into,
          role: 'member'
        }
      ])
      .execute()
    await f.h.db
      .insertInto('season_teams')
      .values([
        { season_id: f.seasonB, team_id: f.teamA, active: true },
        { season_id: f.seasonB, team_id: into, active: false }
      ])
      .execute()
    const report = await mergeTeams(f.h.db, {
      fromTeamId: f.teamA,
      intoTeamId: into,
      apply: true
    })
    expect(report.applied).equals(true)
    const canonical = (await (
      await f.h.request('GET', `/teams/${f.teamA}`, undefined, null)
    ).json()) as { group: { id: string } }
    expect(canonical.group.id).equals(into)
    expect(
      (
        await f.h.db
          .selectFrom('season_team_parents')
          .select('season_id')
          .where('team_id', '=', into)
          .execute()
      )
        .map(row => row.season_id)
        .sort()
    ).deep.equals([f.seasonA, f.playoffs].sort())
    expect(
      (
        await f.h.db
          .selectFrom('memberships')
          .select('role')
          .where('team_id', '=', into)
          .where('user_id', '=', userIdOfGumbo(101))
          .executeTakeFirstOrThrow()
      ).role
    ).equals('owner')
    expect(
      (
        await f.h.db
          .selectFrom('season_teams')
          .select('active')
          .where('team_id', '=', into)
          .where('season_id', '=', f.seasonB)
          .executeTakeFirstOrThrow()
      ).active
    ).equals(true)
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select('user_id')
        .where('scope_type', '=', 'team')
        .where('scope_id', '=', into)
        .where('role', '=', 'admin')
        .execute()
    ).deep.equals([{ user_id: userIdOfGumbo(101) }])
    await rejects(mergeParents(f.h.db, f.teamA, into), 'conflict')
  })
  it('keeps the full team lineage when an external duplicate is resolved and closes old placeholder requests', async () => {
    await f.h.db
      .insertInto('teams')
      .values({
        id: 'mergePlaceholder',
        name: 'Demo Duplicate',
        kind: 'external',
        custodian_type: 'season',
        custodian_id: f.seasonB
      })
      .execute()
    const sent = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'promotion',
        teamId: 'mergePlaceholder',
        recipientUserId: userIdOfGumbo(103),
        sender: { kind: 'team', id: 'mergePlaceholder' },
        idempotencyKey: 'merge-placeholder-invite'
      },
      102
    )
    const request = (await sent.json()) as { id: string }
    await mergeTeams(f.h.db, {
      fromTeamId: 'mergePlaceholder',
      intoTeamId: f.teamA,
      apply: true
    })
    expect(
      (
        await f.h.db
          .selectFrom('teams')
          .select('league_id')
          .where('id', '=', f.teamA)
          .executeTakeFirstOrThrow()
      ).league_id
    ).equals(f.leagueA)
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', request.id)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('superseded')
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select('id')
        .where('scope_id', '=', f.teamA)
        .where('user_id', '=', userIdOfGumbo(102))
        .execute()
    ).length(0)
  })
})
