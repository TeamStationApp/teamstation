import { appendFileSync } from 'node:fs'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { GameIntent } from '../../common/gameApprovals'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { canAdminister } from '../groups/rights'
import { finishGameRequest, requireImmediateGameConsent } from './gameApprovals'
import { seasonGameConsent } from './seasonGameConsent'

describe('active season participant scheduling consent', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async function () {
    f = await groupFixture()
    note({ scenario: this.currentTest?.title }, 'begin')
    const request = f.h.request
    f.h.request = async (method, route, body, user = 101) => {
      note(
        {
          method,
          route,
          body,
          actor: typeof user === 'number' ? user : 'synthetic session'
        },
        'HTTP request follows'
      )
      return await request(method, route, body, user)
    }
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const game = (): GameIntent => ({
    homeTeamId: f.teamB,
    awayTeamId: f.standaloneTeam,
    seasonId: f.seasonA,
    startAt: '2027-04-10T19:00:00.000Z',
    status: 'scheduled',
    venue: null,
    outsideTournament: null
  })
  async function members(): Promise<void> {
    await f.h.db
      .insertInto('season_teams')
      .values(
        [f.teamB, f.standaloneTeam].map(teamId => ({
          team_id: teamId,
          season_id: f.seasonA,
          active: true
        }))
      )
      .onConflict(oc =>
        oc.columns(['season_id', 'team_id']).doUpdateSet({ active: true })
      )
      .execute()
  }
  async function grant(
    role: 'admin' | 'coach' | 'assistant',
    user = 106
  ): Promise<void> {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: `consent_${role}_${user}`,
        user_id: user,
        scope_type: 'season',
        scope_id: f.seasonA,
        role
      })
      .execute()
  }
  async function send(
    user = 101,
    intent = game(),
    key = 'participant-create'
  ): Promise<{ id: string; status: string; gameId: string | null }> {
    const response = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        game: intent,
        idempotencyKey: key
      },
      user
    )
    expect(response.status).equals(201)
    return (await response.json()) as {
      id: string
      status: string
      gameId: string | null
    }
  }
  function note(input: unknown, result: unknown): void {
    if (process.env.TS_CREATION_HTTP_LOG != null)
      appendFileSync(
        process.env.TS_CREATION_HTTP_LOG,
        `$ seasonGameConsent ${JSON.stringify(input)}\n${JSON.stringify(result)}\n`
      )
  }
  for (const inherited of [false, true])
    it(`publishes immediately using ${inherited ? 'inherited' : 'direct'} season admin consent for two unmanaged members`, async () => {
      await members()
      let user = 101
      if (!inherited) {
        user = 106
        await grant('admin')
      } else
        await f.h.db
          .deleteFrom('scope_roles')
          .where('user_id', '=', user)
          .where('scope_type', '=', 'season')
          .where('scope_id', '=', f.seasonA)
          .execute()
      for (const id of [f.teamB, f.standaloneTeam])
        expect(
          await canAdminister(f.h.db, actor(user), { kind: 'team', id })
        ).equals(false)
      const sent = await send(user)
      expect(sent.status).equals('accepted')
      expect(sent.gameId).not.equals(null)
      const stored = await f.h.db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', sent.gameId!)
        .executeTakeFirstOrThrow()
      expect(stored.season_id).equals(f.seasonA)
      const again = await send(user)
      expect(again).deep.equals(sent)
      expect(await f.h.db.selectFrom('games').select('id').execute()).length(1)
      for (const id of [f.teamB, f.standaloneTeam])
        expect(
          await canAdminister(f.h.db, actor(user), { kind: 'team', id })
        ).equals(false)
    })
  for (const state of [
    'missing',
    'inactive',
    'otherSeason',
    'parentOnly',
    'gamesOnly'
  ] as const)
    it(`keeps team consent when a participant is ${state}`, async () => {
      await members()
      await f.h.db
        .deleteFrom('season_teams')
        .where('season_id', '=', f.seasonA)
        .where('team_id', '=', f.standaloneTeam)
        .execute()
      if (state === 'inactive')
        await f.h.db
          .insertInto('season_teams')
          .values({
            season_id: f.seasonA,
            team_id: f.standaloneTeam,
            active: false
          })
          .execute()
      if (state === 'otherSeason')
        await f.h.db
          .insertInto('season_teams')
          .values({
            season_id: f.playoffs,
            team_id: f.standaloneTeam,
            active: true
          })
          .execute()
      if (state === 'parentOnly') {
        await f.h.db
          .updateTable('teams')
          .set({ league_id: f.leagueA })
          .where('id', '=', f.standaloneTeam)
          .execute()
        await f.h.db
          .insertInto('season_team_parents')
          .values({ season_id: f.seasonA, team_id: f.standaloneTeam })
          .execute()
      }
      if (state === 'gamesOnly')
        await f.h.db
          .insertInto('games')
          .values({
            id: 'gam_consent_history',
            home_team_id: f.teamB,
            away_team_id: f.standaloneTeam,
            season_id: f.seasonA,
            start_at: new Date(game().startAt),
            status: 'final'
          })
          .execute()
      const sent = await send()
      expect(sent.status).equals('pending')
      expect(sent.gameId).equals(null)
      const created = await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('season_id', '=', f.seasonA)
        .where('team_id', '=', f.standaloneTeam)
        .execute()
      expect(created.length).equals(state === 'inactive' ? 1 : 0)
    })
  for (const variant of [
    'outside',
    'otherHost',
    'sameTeam',
    'unrelated',
    'coach',
    'assistant'
  ] as const)
    it(`does not delegate for ${variant}`, async () => {
      await members()
      const intent = game()
      let user = 101
      if (variant === 'outside') intent.seasonId = null
      if (variant === 'otherHost') intent.seasonId = f.playoffs
      if (variant === 'sameTeam') intent.awayTeamId = intent.homeTeamId
      if (variant === 'unrelated') user = 104
      if (variant === 'coach' || variant === 'assistant') {
        user = 106
        await grant(variant)
      }
      const result = await seasonGameConsent(f.h.db, actor(user), intent)
      note({ user, game: intent }, result)
      expect(result).equals(false)
    })
  it('allows immediate batch consent only when every game has an authorized host and two members', async () => {
    await members()
    await requireImmediateGameConsent(f.h.db, actor(101), [game()])
    note(
      { service: 'requireImmediateGameConsent', games: [game()], user: 101 },
      'allowed'
    )
    for (const intent of [
      { ...game(), seasonId: null },
      { ...game(), seasonId: f.seasonB }
    ]) {
      let caught: unknown
      try {
        await requireImmediateGameConsent(f.h.db, actor(101), [game(), intent])
      } catch (error) {
        caught = error
      }
      expect(caught).instanceOf(Error)
      note(
        {
          service: 'requireImmediateGameConsent',
          games: [game(), intent],
          user: 101
        },
        String(caught)
      )
    }
  })
  for (const lost of ['participation', 'admin'] as const)
    it(`rechecks a stored season approval after ${lost} is revoked`, async () => {
      const pending = await send()
      expect(pending.status).equals('pending')
      await members()
      await grant('admin')
      await f.h.db
        .updateTable('group_request_sides')
        .set({ approved_by: 106, approved_at: new Date() })
        .where('request_id', '=', pending.id)
        .execute()
      if (lost === 'participation') {
        const ended = await f.h.request(
          'DELETE',
          `/seasons/${f.seasonA}/memberships/${f.teamB}`,
          undefined,
          101
        )
        expect(ended.status).equals(200)
      } else
        await f.h.db
          .deleteFrom('scope_roles')
          .where('id', '=', 'consent_admin_106')
          .execute()
      const finished = await f.h.db
        .transaction()
        .execute(async trx => await finishGameRequest(trx, pending.id, f.clock))
      note({ service: 'finishGameRequest', id: pending.id, lost }, finished)
      expect(finished).equals(false)
      expect(await f.h.db.selectFrom('games').select('id').execute()).length(0)
    })
  it('discovers member-game approvals in the host admin inbox without granting withdrawal authority', async () => {
    await members()
    await grant('admin')
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_consent_inbox',
        home_team_id: f.teamB,
        away_team_id: f.standaloneTeam,
        season_id: f.seasonA,
        start_at: new Date(game().startAt),
        status: 'scheduled'
      })
      .execute()
    const snapshot = (await (
      await f.h.request(
        'GET',
        '/games/gam_consent_inbox/scheduling',
        undefined,
        102
      )
    ).json()) as { version: string }
    const response = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamB },
        game: { ...game(), venue: 'Demo Field' },
        gameId: 'gam_consent_inbox',
        expected: snapshot.version,
        idempotencyKey: 'participant-inbox-revision'
      },
      102
    )
    expect(response.status).equals(201)
    const request = (await response.json()) as { id: string; status: string }
    expect(request.status).equals('pending')
    const read = async (): Promise<{
      hasPending: boolean
      items: Array<{ requestId: string; canAct: boolean; canWithdraw: boolean }>
    }> =>
      (await (
        await f.h.request('GET', '/me/notifications', undefined, 106)
      ).json()) as {
        hasPending: boolean
        items: Array<{
          requestId: string
          canAct: boolean
          canWithdraw: boolean
        }>
      }
    const found = await read()
    expect(found.hasPending).equals(true)
    expect(
      await (
        await f.h.request('GET', '/me/notifications/summary', undefined, 106)
      ).json()
    ).deep.equals({ hasPending: true })
    expect(found.items.find(item => item.requestId === request.id)).includes({
      canAct: true,
      canWithdraw: false
    })
    expect(
      (
        await f.h.request(
          'POST',
          `/game-requests/${request.id}/withdraw`,
          {},
          106
        )
      ).status
    ).equals(403)
    await f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', f.seasonA)
      .where('team_id', '=', f.standaloneTeam)
      .execute()
    expect((await read()).hasPending).equals(false)
    expect(
      await (
        await f.h.request('GET', '/me/notifications/summary', undefined, 106)
      ).json()
    ).deep.equals({ hasPending: false })
    await f.h.db
      .updateTable('season_teams')
      .set({ active: true })
      .where('season_id', '=', f.seasonA)
      .where('team_id', '=', f.standaloneTeam)
      .execute()
    expect((await read()).hasPending).equals(true)
    await f.h.db
      .deleteFrom('scope_roles')
      .where('id', '=', 'consent_admin_106')
      .execute()
    expect(
      (await read()).items.some(item => item.requestId === request.id)
    ).equals(false)
  })
})
