import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  actor,
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { setScopeRoles } from '../invites/people'
import { createRelationshipRequest } from './requests'
import { canAdminister } from './rights'

describe('explicit external custody and verified promotion', function () {
  this.timeout(60000)
  let f: GroupFixture
  let externalId: string
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  it('refuses ordinary invitations to a placeholder while allowing its custodian to invite a verified administrator', async () => {
    const created = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Invitation Placeholder',
        external: true,
        custodian: { kind: 'season', id: f.seasonB },
        locality: demoLocality,
        idempotencyKey: 'placeholder-invitation-guard'
      },
      102
    )
    expect(created.status).equals(201)
    const placeholderId = ((await created.json()) as { id: string }).id
    const scope = { kind: 'team' as const, id: placeholderId }
    expect(await canAdminister(f.h.db, actor(102), scope)).equals(true)
    let rejected: unknown
    try {
      await createRelationshipRequest(
        f.h.db,
        actor(102),
        {
          sender: scope,
          idempotencyKey: 'ordinary-placeholder-invitation',
          terms: {
            kind: 'person',
            scope,
            recipientEmail: 'fixture103@example.com',
            recipientUserId: 103,
            admin: false,
            flags: []
          }
        },
        f.clock
      )
    } catch (error) {
      rejected = error
    }
    expect(rejected).property('code', 'conflict')
    expect(rejected).property(
      'message',
      'Promote a placeholder team before inviting people to it'
    )
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('sender_scope_id', '=', placeholderId)
        .execute()
    ).length(0)
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select('id')
        .where('scope_id', '=', placeholderId)
        .execute()
    ).length(0)
    const promotion = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'promotion',
        teamId: placeholderId,
        recipientUserId: 103,
        sender: scope,
        idempotencyKey: 'verified-placeholder-administrator'
      },
      102
    )
    expect(promotion.status).equals(201)
    const id = ((await promotion.json()) as { id: string }).id
    expect(
      await f.h.db
        .selectFrom('teams')
        .select('kind')
        .where('id', '=', placeholderId)
        .executeTakeFirstOrThrow()
    ).property('kind', 'external')
    const accepted = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      103
    )
    expect(accepted.status).equals(200)
    expect(await accepted.json()).property('status', 'accepted')
    expect(
      await f.h.db
        .selectFrom('teams')
        .select(['kind', 'custodian_id'])
        .where('id', '=', placeholderId)
        .executeTakeFirstOrThrow()
    ).deep.equals({ kind: 'full', custodian_id: null })
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select('user_id')
        .where('scope_id', '=', placeholderId)
        .where('role', '=', 'admin')
        .execute()
    ).deep.equals([{ user_id: 103 }])
  })
  it('creates a custodian-held opponent without an invented account, parent or competition enrollment', async () => {
    const body = {
      name: 'Demo External',
      external: true,
      custodian: { kind: 'season', id: f.seasonB },
      locality: demoLocality,
      idempotencyKey: 'external-opponent'
    }
    expect((await f.h.request('POST', '/teams', body, 101)).status).equals(403)
    const response = await f.h.request('POST', '/teams', body, 102)
    expect(response.status).equals(201)
    externalId = ((await response.json()) as { id: string }).id
    let rejected: unknown
    try {
      await setScopeRoles(
        f.h.db,
        'team',
        externalId,
        103,
        { admin: true, flags: [] },
        105
      )
    } catch (error) {
      rejected = error
    }
    expect(rejected).property('code', 'conflict')
    const row = await f.h.db
      .selectFrom('teams')
      .select(['kind', 'league_id', 'custodian_type', 'custodian_id'])
      .where('id', '=', externalId)
      .executeTakeFirstOrThrow()
    expect(row).deep.equals({
      kind: 'external',
      league_id: null,
      custodian_type: 'season',
      custodian_id: f.seasonB
    })
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select('id')
        .where('scope_id', '=', externalId)
        .execute()
    ).length(0)
    const publicDetail = (await (
      await f.h.request('GET', `/teams/${externalId}`, undefined, null)
    ).json()) as {
      custodian: { id: string }
      parents: unknown[]
      group: { external: boolean }
    }
    expect(publicDetail.group.external).equals(true)
    expect(publicDetail.custodian.id).equals(f.seasonB)
    expect(publicDetail.parents).length(0)
    expect(
      (
        await f.h.request(
          'POST',
          '/teams',
          {
            ...body,
            parent: { kind: 'league', id: f.leagueB },
            idempotencyKey: 'external-parent'
          },
          102
        )
      ).status
    ).equals(400)
    expect(
      (
        await f.h.request(
          'POST',
          '/teams',
          {
            ...body,
            custodian: { kind: 'team', id: externalId },
            idempotencyKey: 'custody-recursion'
          },
          102
        )
      ).status
    ).equals(403)
  })
  it('requires explicit custodian and named recipient consent and keeps the same identity and games', async () => {
    await f.h.db
      .insertInto('games')
      .values({
        id: 'externalHistory',
        home_team_id: f.teamB,
        away_team_id: externalId,
        season_id: f.seasonB,
        start_at: new Date(),
        status: 'final',
        home_score: 4,
        away_score: 1
      })
      .execute()
    const body = {
      kind: 'promotion',
      teamId: externalId,
      recipientUserId: 103,
      sender: { kind: 'team', id: externalId },
      idempotencyKey: 'promote-opponent'
    }
    expect(
      (await f.h.request('POST', '/relationship-requests', body, 101)).status
    ).equals(403)
    const sent = await f.h.request('POST', '/relationship-requests', body, 102)
    expect(sent.status).equals(201)
    const { id } = (await sent.json()) as { id: string }
    expect(
      (
        await f.h.request(
          'POST',
          `/relationship-requests/${id}/accept`,
          {},
          104
        )
      ).status
    ).equals(403)
    const accepted = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      103
    )
    expect(accepted.status).equals(200)
    expect(await accepted.json()).property('status', 'accepted')
    expect(
      await f.h.db
        .selectFrom('teams')
        .select(['kind', 'custodian_type', 'custodian_id'])
        .where('id', '=', externalId)
        .executeTakeFirstOrThrow()
    ).deep.equals({ kind: 'full', custodian_type: null, custodian_id: null })
    expect(
      await f.h.db
        .selectFrom('scope_roles')
        .select('user_id')
        .where('scope_id', '=', externalId)
        .where('role', '=', 'admin')
        .execute()
    ).deep.equals([{ user_id: 103 }])
    expect(
      await f.h.db
        .selectFrom('games')
        .select('away_team_id')
        .where('id', '=', 'externalHistory')
        .executeTakeFirstOrThrow()
    ).property('away_team_id', externalId)
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .select('team_id')
        .where('team_id', '=', externalId)
        .execute()
    ).length(0)
    expect(
      (
        await f.h.request(
          'POST',
          '/relationship-requests',
          { ...body, idempotencyKey: 'promote-already-full' },
          103
        )
      ).status
    ).equals(409)
  })
})
