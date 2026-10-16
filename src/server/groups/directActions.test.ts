import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import type { RequestTerms } from '../../common/notifications'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { completionNotice } from '../notifications/completionNotice'

describe('direct action relationship consent', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  it('describes completed actions without copying invitation or proposal language', async () => {
    const team = { kind: 'team' as const, id: f.teamA }
    const season = { kind: 'season' as const, id: f.seasonA }
    const terms: Array<Exclude<RequestTerms, { kind: 'guardian' }>> = [
      ...[f.seasonA, null].map(seasonId => ({
        kind: 'game' as const,
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId,
          status: 'scheduled' as const,
          startAt: '2027-04-10T19:00:00Z',
          venue: null,
          outsideTournament: null
        },
        affectedTeamIds: [],
        hostSeasonIds: [],
        gameId: null,
        expected: null,
        previous: null
      })),
      {
        kind: 'participation',
        teamId: f.teamA,
        seasonId: f.seasonA,
        range: { startsOn: null, endsOn: null, timezone: 'UTC' }
      },
      { kind: 'promotion', teamId: f.teamA, recipientUserId: 101 },
      {
        kind: 'person',
        scope: team,
        recipientEmail: 'member@example.test',
        recipientUserId: 101,
        admin: true,
        flags: []
      },
      ...(['attach', 'detach'] as const).map(operation => ({
        kind: 'parent' as const,
        preview: {
          actions: [],
          effects: [{ operation, parent: season, child: team }],
          expected: {},
          explanation: []
        }
      })),
      {
        kind: 'parent',
        preview: { actions: [], effects: [], expected: {}, explanation: [] }
      }
    ]
    for (const term of terms) {
      const notice = await completionNotice(f.h.db, term)
      expect(notice).not.match(/invited|proposed/i)
      expect(notice).includes(
        term.kind === 'parent' && term.preview.effects.length === 0
          ? 'No management connections changed'
          : 'Demo Hawks'
      )
    }
  })
  it('distinguishes an imported unverified alias from a verified self address', async () => {
    const api = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)
    })
    await f.h.db
      .insertInto('user_emails')
      .values({
        id: 'email_imported',
        user_id: 101,
        email: 'imported@example.test',
        is_primary: false,
        verified_at: null
      })
      .execute()
    const account = await api.accountSettings()
    expect(
      account.emails.find(row => row.email === 'imported@example.test')
        ?.isVerified
    ).equals(false)
    expect(
      account.emails.find(row => row.email === 'alex@example.com')?.isVerified
    ).equals(true)
  })
  for (const both of [true, false])
    it(`resends a connection with ${both ? 'all available approvals applied and a return source' : 'other-side consent still pending'}`, async () => {
      const api = new TeamStationClient({
        baseUrl: f.h.origin + '/api/v1',
        token: f.h.tokens.get(101)
      })
      const sent = await api.inviteRelationship({
        kind: 'participation',
        sender: { kind: 'season', id: f.seasonA },
        teamId: f.standaloneTeam,
        seasonId: f.seasonA,
        idempotencyKey: 'direct-resend-before'
      })
      expect(sent.status).equals('pending')
      if (both)
        await f.h.db
          .insertInto('scope_roles')
          .values({
            id: 'role_resend_other',
            user_id: 101,
            scope_type: 'team',
            scope_id: f.standaloneTeam,
            role: 'admin'
          })
          .execute()
      const result = await api.decideRelationship(
        sent.id,
        'resend',
        'direct-resend-after'
      )
      expect(result.status).equals(both ? 'accepted' : 'pending')
      expect(result.source).deep.equals(
        both ? { kind: 'season', id: f.seasonA } : undefined
      )
      if (both)
        expect(result.notice)
          .includes('Demo Visitors')
          .and.includes('Demo Regular')
      else expect(result.notice).equals(undefined)
      expect(
        await api.decideRelationship(sent.id, 'resend', 'direct-resend-after')
      ).deep.equals(result)
    })
  for (const own of [true, false])
    it(`applies ${own ? 'self consent' : 'only sender consent'} when an invited address becomes verified before resubmission`, async () => {
      const api = new TeamStationClient({
        baseUrl: f.h.origin + '/api/v1',
        token: f.h.tokens.get(101)
      })
      const sent = await api.inviteRelationship({
        kind: 'person',
        sender: { kind: 'season', id: f.seasonA },
        recipientEmail: 'new-access@example.test',
        admin: true,
        flags: [],
        idempotencyKey: 'resend-person-before'
      })
      expect(sent.status).equals('pending')
      await f.h.db
        .insertInto('user_emails')
        .values({
          id: 'email_new_access',
          user_id: own ? 101 : 102,
          email: 'new-access@example.test',
          is_primary: false,
          verified_at: new Date()
        })
        .execute()
      const result = await api.decideRelationship(
        sent.id,
        'resend',
        'resend-person-after'
      )
      expect(result.status).equals(own ? 'accepted' : 'pending')
      if (own) expect(result.notice).includes('new-access@example.test')
    })
  it('returns a game and factual notice when newly active participants make a resend immediate', async () => {
    const api = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)
    })
    const sent = await api.proposeGame({
      sender: { kind: 'season', id: f.seasonA },
      game: {
        homeTeamId: f.teamB,
        awayTeamId: f.standaloneTeam,
        seasonId: f.seasonA,
        startAt: '2027-04-10T19:00:00Z',
        status: 'scheduled',
        venue: null,
        outsideTournament: null
      },
      idempotencyKey: 'sdk-resend-game-before'
    })
    expect(sent.status).equals('pending')
    await f.h.db
      .insertInto('season_teams')
      .values(
        [f.teamB, f.standaloneTeam].map(teamId => ({
          season_id: f.seasonA,
          team_id: teamId,
          active: true
        }))
      )
      .onConflict(oc =>
        oc.columns(['season_id', 'team_id']).doUpdateSet({ active: true })
      )
      .execute()
    const saved = await api.decideGameRequest(
      sent.id,
      'resend',
      'sdk-resend-game-after'
    )
    expect(saved.status).equals('accepted')
    expect(saved.gameId).not.equals(null)
    expect(saved.notice)
      .includes('Demo Eagles')
      .and.includes('Demo Visitors')
      .and.includes('Demo Regular')
    expect(
      await api.decideGameRequest(sent.id, 'resend', 'sdk-resend-game-after')
    ).deep.equals(saved)
  })
  for (const self of [true, false])
    it(`promotes ${self ? 'the verified custodian admin immediately' : 'another account only after its own consent'}`, async () => {
      const api = new TeamStationClient({
        baseUrl: f.h.origin + '/api/v1',
        token: f.h.tokens.get(101)
      })
      const created = await api.createGroup({
        kind: 'team',
        external: true,
        name: 'Demo Promotion',
        custodian: { kind: 'season', id: f.seasonA },
        idempotencyKey: 'direct-create-placeholder'
      })
      const body = {
        kind: 'promotion' as const,
        sender: { kind: 'team' as const, id: created.id },
        teamId: created.id,
        recipientEmail: self ? 'alex@example.com' : 'casey@example.com',
        confirmBoth: true,
        idempotencyKey: 'direct-promote-placeholder'
      }
      const sent = await api.inviteRelationship(body)
      expect(sent.status).equals(self ? 'accepted' : 'pending')
      expect((await api.inviteRelationship(body)).id).equals(sent.id)
      const team = await f.h.db
        .selectFrom('teams')
        .select(['kind', 'custodian_id'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow()
      expect(team.kind).equals(self ? 'full' : 'external')
      expect(team.custodian_id).equals(self ? null : f.seasonA)
      if (!self) {
        const recipient = new TeamStationClient({
          baseUrl: f.h.origin + '/api/v1',
          token: f.h.tokens.get(102)
        })
        expect(
          (await recipient.decideRelationship(sent.id, 'accept')).status
        ).equals('accepted')
      }
    })
})
