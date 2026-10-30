import { createHash } from 'node:crypto'

import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  asGameProposal,
  asGameTimezone,
  type GameIntent
} from '../../common/gameApprovals'
import { asScheduleGameRow } from '../../common/scheduleGames'
import { userIdOfGumbo } from '../../common/userId'
import { migration052SeasonGameRefinements } from '../../migrate/migrations/052seasonGameRefinements'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { setScopeRoles } from '../invites/people'
import { titleAndDescription } from '../notifications/requestInformation'
import {
  gameVersion,
  materialGame,
  proposeGame,
  withdrawFromGame
} from './gameApprovals'
import { scheduleGames } from './scheduleGames'

describe('two-team scheduling and replacement history', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  it('returns effective expiration on actual HTTP proposal retry without duplicating the stored request', async () => {
    const sent = await send(intent(), 'natural-expired-replay')
    f.advance(8 * 24 * 60 * 60 * 1000)
    const replay = await send(intent(), 'natural-expired-replay')
    expect(replay).includes({ id: sent.id, status: 'expired' })
    const stored = await f.h.db
      .selectFrom('group_requests')
      .select(['id', 'status'])
      .where('kind', '=', 'game')
      .execute()
    expect(stored).deep.equals([{ id: sent.id, status: 'pending' }])
    const inbox = await f.h.request(
      'GET',
      `/me/notifications/${sent.id}`,
      undefined,
      102
    )
    expect(inbox.status).equals(200)
    expect(await inbox.json()).includes({ status: 'expired', canAct: false })
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(0)
  })
  it('returns effective expiration on actual HTTP resend-key replay without sending another invitation', async () => {
    const original = await send(intent(), 'natural-expired-resend-original')
    f.advance(8 * 24 * 60 * 60 * 1000)
    const path = `/game-requests/${original.id}/resend`
    const body = { idempotencyKey: 'natural-expired-resend-key' }
    const first = await f.h.request('POST', path, body, 101)
    expect(first.status).equals(201)
    const fresh = await first.json()
    expect(fresh.status).equals('pending')
    f.advance(8 * 24 * 60 * 60 * 1000)
    const repeated = await f.h.request('POST', path, body, 101)
    expect(repeated.status).equals(201)
    expect(await repeated.json()).includes({ id: fresh.id, status: 'expired' })
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length(2)
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(0)
  })
  for (const status of ['pending', 'accepted'] as const)
    it(`replays a persisted pre-upgrade normalized body hash with ${status} status and no duplicate game`, async () => {
      // This literal preserves the field order of the pinned parent's cleaner,
      // including canonical ISO time and trimmed nullable text, without the new fields.
      const raw = {
        sender: { kind: 'team', id: f.teamA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-10T19:00:00Z',
          venue: ' Demo Legacy Field '
        },
        idempotencyKey: `legacy-body-${status}`
      }
      const normalized = {
        sender: raw.sender,
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-10T19:00:00.000Z',
          venue: 'Demo Legacy Field',
          outsideTournament: null,
          status: 'scheduled'
        },
        idempotencyKey: raw.idempotencyKey
      }
      const initial = await f.h.request('POST', '/game-requests', raw, 101)
      expect(initial.status).equals(201)
      const sent = await initial.json()
      await f.h.db
        .updateTable('creation_idempotency')
        .set({
          response: sql`response - 'gameProposalVersion'`,
          body_hash: createHash('sha256')
            .update(JSON.stringify(normalized))
            .digest('hex')
        })
        .where('user_id', '=', userIdOfGumbo(101))
        .where('key', '=', raw.idempotencyKey)
        .execute()
      const gameId =
        status === 'accepted' ? (await accept(sent.id, 102)).gameId : null
      for (const game of [raw.game, { ...raw.game, exhibition: false }]) {
        const retried = await f.h.request(
          'POST',
          '/game-requests',
          { ...raw, game },
          101
        )
        expect(retried.status, await retried.clone().text()).equals(201)
        expect(await retried.json()).includes({ id: sent.id, status, gameId })
      }
      expect(
        await f.h.db
          .selectFrom('group_requests')
          .select('id')
          .where('kind', '=', 'game')
          .execute()
      ).length(1)
      expect(await f.h.db.selectFrom('games').select('id').execute()).length(
        status === 'accepted' ? 1 : 0
      )
    })
  it('allows only legacy-default material fields while preserving exact legacy revision details and expected version', async () => {
    const original = await send(
      { ...intent(), timezone: 'UTC' },
      'legacy-revision-original'
    )
    const oldId = (await accept(original.id, 102)).gameId
    const canonical = materialGame(await row(oldId))
    const legacyGame = { ...canonical }
    delete legacyGame.exhibition
    delete legacyGame.timezone
    // Legacy versions had the same material order, minus timezone/classification.
    const expected = gameVersion(legacyGame)
    const raw = {
      sender: { kind: 'team', id: f.teamA },
      game: { ...legacyGame, venue: 'Demo Legacy Revision' },
      gameId: oldId,
      expected,
      initiatingTeamId: f.teamA,
      idempotencyKey: 'legacy-revision-hash'
    }
    const response = await f.h.request('POST', '/game-requests', raw, 101)
    expect(response.status).equals(201)
    const sent = await response.json()
    const cleaned = asGameProposal(raw)
    const normalized = { ...cleaned, game: { ...cleaned.game } }
    delete normalized.game.exhibition
    delete normalized.game.timezone
    await f.h.db
      .updateTable('creation_idempotency')
      .set({
        response: sql`response - 'gameProposalVersion'`,
        body_hash: createHash('sha256')
          .update(JSON.stringify(normalized))
          .digest('hex')
      })
      .where('user_id', '=', userIdOfGumbo(101))
      .where('key', '=', raw.idempotencyKey)
      .execute()
    for (const changed of [
      { ...raw, game: { ...raw.game, exhibition: true } },
      { ...raw, game: { ...raw.game, timezone: 'UTC' } },
      { ...raw, game: { ...raw.game, timezone: 'America/Los_Angeles' } },
      { ...raw, game: { ...raw.game, venue: 'Different field' } },
      { ...raw, game: { ...raw.game, status: 'cancelled' } },
      { ...raw, game: { ...raw.game, startAt: '2027-04-11T19:00:00Z' } },
      { ...raw, expected: '0'.repeat(64) },
      { ...raw, gameId: 'different-game-id' },
      { ...raw, initiatingTeamId: f.teamB },
      { ...raw, sender: { kind: 'season', id: f.seasonA } }
    ]) {
      const rejected = await f.h.request('POST', '/game-requests', changed, 101)
      expect(rejected.status, await rejected.clone().text()).equals(409)
      expect(await rejected.json())
        .property('message')
        .includes('different game details')
    }
    const replay = await f.h.request('POST', '/game-requests', raw, 101)
    expect(replay.status).equals(201)
    expect(await replay.json()).includes({ id: sent.id, status: 'pending' })
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length(2)
    expect((await row(oldId)).venue).equals('Demo Field')
  })
  it('preserves omitted existing-game classification and timezone while allowing explicit material edits and refusing changed same-key intent', async () => {
    await grant(f.teamB, 101)
    const original = await send(
      { ...intent(), exhibition: true, timezone: 'America/New_York' },
      'preserve-omitted-original'
    )
    expect(original.status).equals('accepted')
    const gameId = original.gameId
    const current = await (
      await f.h.request('GET', `/games/${gameId}/scheduling`, undefined, 101)
    ).json()
    const game = { ...current.game, venue: 'Demo Legacy Venue Edit' }
    delete game.exhibition
    delete game.timezone
    const body = {
      sender: { kind: 'team', id: f.teamA },
      game,
      gameId,
      expected: current.version,
      idempotencyKey: 'preserve-omitted-edit'
    }
    const changed = await f.h.request('POST', '/game-requests', body, 101)
    expect(changed.status).equals(201)
    const saved = await changed.json()
    expect(saved).includes({ status: 'accepted', gameId })
    expect(await row(gameId)).includes({
      venue: 'Demo Legacy Venue Edit',
      exhibition: true,
      timezone: 'America/New_York'
    })
    for (const explicit of [
      { ...game, exhibition: false },
      { ...game, timezone: 'UTC' }
    ]) {
      const rejected = await f.h.request(
        'POST',
        '/game-requests',
        { ...body, game: explicit },
        101
      )
      expect(rejected.status).equals(409)
    }
    const retried = await f.h.request('POST', '/game-requests', body, 101)
    expect(retried.status).equals(201)
    expect(await retried.json()).includes({ id: saved.id, status: 'accepted' })
    const scheduling = await (
      await f.h.request('GET', `/games/${gameId}/scheduling`, undefined, 101)
    ).json()
    const explicit = await f.h.request(
      'POST',
      '/game-requests',
      {
        ...body,
        game: { ...game, exhibition: false, timezone: 'UTC' },
        expected: scheduling.version,
        idempotencyKey: 'preserve-explicit-material'
      },
      101
    )
    expect(explicit.status).equals(201)
    expect((await explicit.json()).status).equals('accepted')
    expect(await row(gameId)).includes({ exhibition: false, timezone: 'UTC' })
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(1)
  })
  it('replays unversioned cache hashes from the former inserted-false cleaner without treating explicit timezone as legacy omission', async () => {
    const game = { ...intent() }
    delete game.exhibition
    delete game.timezone
    const raw = {
      sender: { kind: 'team', id: f.teamA },
      game,
      idempotencyKey: 'former-default-false-cache'
    }
    const initial = await f.h.request('POST', '/game-requests', raw, 101)
    expect(initial.status).equals(201)
    const sent = await initial.json()
    const formerlyNormalized = asGameProposal(raw)
    formerlyNormalized.game.exhibition = false
    await f.h.db
      .updateTable('creation_idempotency')
      .set({
        body_hash: createHash('sha256')
          .update(JSON.stringify(formerlyNormalized))
          .digest('hex'),
        response: sql`response - 'gameProposalVersion'`
      })
      .where('user_id', '=', userIdOfGumbo(101))
      .where('key', '=', raw.idempotencyKey)
      .execute()
    const repeated = await f.h.request('POST', '/game-requests', raw, 101)
    expect(repeated.status).equals(201)
    expect(await repeated.json()).includes({ id: sent.id, status: 'pending' })
    for (const changed of [
      { ...game, exhibition: true },
      { ...game, timezone: 'UTC' }
    ])
      expect(
        (
          await f.h.request(
            'POST',
            '/game-requests',
            { ...raw, game: changed },
            101
          )
        ).status
      ).equals(409)
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length(1)
  })
  it('rejects a key held by another request kind rather than using a legacy game-hash fallback', async () => {
    const person = await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      {
        // An address nobody holds, so the key is spent on an invitation.
        email: 'cross-kind@example.com',
        admin: false,
        flags: ['coach'],
        idempotencyKey: 'cross-kind-body-key'
      },
      101
    )
    expect(person.status).equals(201)
    const wrong = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: intent(),
        idempotencyKey: 'cross-kind-body-key'
      },
      101
    )
    expect(wrong.status).equals(409)
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length(0)
  })
  it('requires persisted and immutable replacement context when called by server code', async () => {
    const old = await published()
    const proposal = await replace(old, 'stored-resume-only')
    const original = await f.h.db
      .selectFrom('group_requests')
      .select('terms')
      .where('id', '=', proposal.id)
      .executeTakeFirstOrThrow()
    const body = {
      sender: { kind: 'team' as const, id: f.teamA },
      game: { ...intent(), awayTeamId: f.standaloneTeam },
      idempotencyKey: 'forged-server-resume'
    }
    for (const [resume, game] of [
      [original.terms, body.game],
      [proposal.id, { ...body.game, venue: 'Changed continuation' }]
    ] as const) {
      let failure: unknown
      try {
        await proposeGame(
          f.h.db,
          actor(101),
          { ...body, game },
          f.clock,
          resume as string
        )
      } catch (error) {
        failure = error
      }
      expect(failure).instanceOf(Error)
      expect((failure as Error).message).matches(
        /stored invitation|stored game details/
      )
    }
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length(2)
  })
  it('formats legacy request display times using season or UTC fallbacks', async () => {
    const pending = await send(intent(), 'legacy-display-time')
    const request = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', pending.id)
      .executeTakeFirstOrThrow()
    // Stored with nothing frozen, it reads every group and zone live.
    await f.h.db
      .updateTable('notification_events')
      .set({ metadata: sql`metadata - 'frozen'` })
      .where('source_id', '=', pending.id)
      .execute()
    const legacyGame = { ...intent() }
    delete legacyGame.timezone
    for (const seasonId of [f.seasonA, null, 'season_missing']) {
      const shown = await titleAndDescription(f.h.db, {
        ...request,
        terms: {
          ...(request.terms as object),
          game: { ...legacyGame, seasonId },
          previous: {
            ...legacyGame,
            seasonId,
            venue: seasonId == null ? null : 'Demo Previous Field'
          }
        }
      })
      expect(shown.description).includes('(UTC)')
      expect(shown.description).includes('Previously')
    }
    const promotion = await titleAndDescription(f.h.db, {
      ...request,
      terms: { kind: 'promotion', teamId: f.teamB }
    })
    expect(promotion.description).includes('placeholder team')
    expect(promotion.description).not.includes('external team')
  })
  const intent = (): GameIntent => ({
    homeTeamId: f.teamA,
    awayTeamId: f.teamB,
    seasonId: f.seasonA,
    startAt: '2027-04-10T19:00:00Z',
    venue: 'Demo Field',
    outsideTournament: null,
    status: 'scheduled',
    exhibition: false,
    timezone: 'America/Los_Angeles'
  })
  const send = async (
    game: GameIntent,
    key: string,
    gameId?: string,
    expected?: string
  ): Promise<any> => {
    const r = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game,
        idempotencyKey: key,
        ...(gameId == null ? {} : { gameId, expected })
      },
      101
    )
    expect(r.status, await r.clone().text()).equals(201)
    return await r.json()
  }
  const accept = async (id: string, user: number): Promise<any> => {
    const r = await f.h.request('POST', `/game-requests/${id}/accept`, {}, user)
    expect(r.status, await r.clone().text()).equals(200)
    return await r.json()
  }
  const published = async (): Promise<string> =>
    (await accept((await send(intent(), 'refine-published')).id, 102)).gameId
  const row = async (id: string): Promise<any> =>
    await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const grant = async (team: string, user: number): Promise<void> => {
    await setScopeRoles(
      f.h.db,
      'team',
      team,
      userIdOfGumbo(user),
      { admin: true, flags: [] },
      userIdOfGumbo(105)
    )
  }
  const replace = async (id: string, key = 'replace-unmanaged'): Promise<any> =>
    await send(
      { ...intent(), awayTeamId: f.standaloneTeam },
      key,
      id,
      gameVersion(materialGame(await row(id)))
    )

  it('requires hosting placement authority even when the initiating team administrator controls both proposed teams', async () => {
    await grant(f.teamB, 101)
    const rejected = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: { ...intent(), seasonId: f.seasonB },
        idempotencyKey: 'team-foreign-season'
      },
      101
    )
    expect(rejected.status).equals(403)
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length(0)
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(0)
    const outside = await send(
      { ...intent(), seasonId: null },
      'team-outside-placement'
    )
    expect(outside.status).equals('accepted')
    const owned = await send(intent(), 'team-owned-placement')
    expect(owned.status).equals('accepted')
    const sides = await f.h.db
      .selectFrom('group_request_sides')
      .select('scope_type')
      .where('request_id', '=', owned.id)
      .execute()
    expect(sides).length(2)
    expect(sides.every(side => side.scope_type === 'team')).equals(true)
  })
  it('lets a host organizer initiate visiting-team games while requiring both team approvals and forbidding accepted-game edits', async () => {
    const r = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        game: {
          ...intent(),
          homeTeamId: f.teamB,
          awayTeamId: f.standaloneTeam
        },
        idempotencyKey: 'host-only-no-teams'
      },
      101
    )
    expect(r.status).equals(201)
    const proposal = await r.json()
    expect(proposal.status).equals('pending')
    const sides = await f.h.db
      .selectFrom('group_request_sides')
      .selectAll()
      .where('request_id', '=', proposal.id)
      .execute()
    expect(sides).length(2)
    expect(sides.every(side => side.approved_by == null)).equals(true)
    expect(
      (
        await f.h.request(
          'POST',
          `/game-requests/${proposal.id}/accept`,
          {},
          101
        )
      ).status
    ).equals(403)
    expect((await accept(proposal.id, 102)).status).equals('pending')
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(0)
    const accepted = await accept(proposal.id, 103)
    expect(accepted.status).equals('accepted')
    const original = materialGame(await row(accepted.gameId))
    const change = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        gameId: accepted.gameId,
        expected: gameVersion(original),
        game: { ...original, venue: 'Demo Changed Field' },
        idempotencyKey: 'host-cannot-edit-accepted-game'
      },
      101
    )
    expect(change.status).equals(403)
    expect((await row(accepted.gameId)).venue).equals(original.venue)
    expect(
      (
        await f.h.request(
          'GET',
          `/games/${accepted.gameId}/scheduling`,
          undefined,
          101
        )
      ).status
    ).equals(403)
  })
  it('accepts legacy hosted requests authorized by their current original sender even without a captured host receipt', async () => {
    const proposal = await send(intent(), 'legacy-sender-host-authority')
    await f.h.db
      .updateTable('group_requests')
      .set({
        terms: sql`terms - 'hostingAuthorizerUserId' - 'hostingAuthorizationSource'`
      })
      .where('id', '=', proposal.id)
      .execute()
    expect((await accept(proposal.id, 102)).status).equals('accepted')
    expect(
      await f.h.db
        .selectFrom('group_request_sides')
        .select('scope_type')
        .where('request_id', '=', proposal.id)
        .execute()
    ).deep.equals([{ scope_type: 'team' }, { scope_type: 'team' }])
  })
  const revokeHosting = async (): Promise<void> => {
    for (const [kind, id] of [
      ['league', f.leagueA],
      ['season', f.seasonA]
    ] as const) {
      await setScopeRoles(
        f.h.db,
        kind,
        id,
        userIdOfGumbo(105),
        { admin: true, flags: [] },
        userIdOfGumbo(105)
      )
      await setScopeRoles(
        f.h.db,
        kind,
        id,
        userIdOfGumbo(101),
        { admin: false, flags: [] },
        userIdOfGumbo(105)
      )
    }
  }
  it('refuses an outsider controlling only proposed teams even with the exact public material digest, without canceling the original', async () => {
    const gameId = await published()
    const before = await row(gameId)
    const made = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Proposed Only Team',
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        },
        idempotencyKey: 'proposed-only-team'
      },
      103
    )
    expect(made.status).equals(201)
    const other = (await made.json()).id
    const denied = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.standaloneTeam },
        game: {
          ...materialGame(before),
          homeTeamId: f.standaloneTeam,
          awayTeamId: other
        },
        gameId,
        expected: gameVersion(materialGame(before)),
        idempotencyKey: 'proposed-only-hijack'
      },
      103
    )
    expect(denied.status).equals(403)
    expect(await row(gameId)).deep.equals(before)
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(1)
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('kind', '=', 'game')
        .execute()
    ).length(1)
  })
  for (const loss of ['revoked', 'disabled'] as const)
    it(`revalidates the current active hosted-placement authorizer when ${loss}, without adding a third consent`, async () => {
      const created = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'season', id: f.seasonA },
          game: {
            ...intent(),
            homeTeamId: f.teamB,
            awayTeamId: f.standaloneTeam
          },
          idempotencyKey: 'host-authorizer-' + loss
        },
        101
      )
      expect(created.status).equals(201)
      const proposal = await created.json()
      const stored = await f.h.db
        .selectFrom('group_requests')
        .select('terms')
        .where('id', '=', proposal.id)
        .executeTakeFirstOrThrow()
      expect(stored.terms).includes({
        hostingAuthorizerUserId: userIdOfGumbo(101),
        hostingAuthorizationSource: 'initiator'
      })
      expect((await accept(proposal.id, 102)).status).equals('pending')
      if (loss === 'revoked') await revokeHosting()
      else
        await f.h.db
          .updateTable('users')
          .set({ login_enabled: false })
          .where('id', '=', userIdOfGumbo(101))
          .execute()
      const blocked = await f.h.request(
        'POST',
        `/game-requests/${proposal.id}/accept`,
        {},
        103
      )
      expect(blocked.status).equals(409)
      expect(await f.h.db.selectFrom('games').select('id').execute()).length(0)
      expect(
        await f.h.db
          .selectFrom('group_request_sides')
          .select('scope_type')
          .where('request_id', '=', proposal.id)
          .execute()
      ).deep.equals([{ scope_type: 'team' }, { scope_type: 'team' }])
    })
  for (const receipt of [
    'valid',
    'unapproved',
    'wrong-season',
    'revoked',
    'disabled'
  ] as const)
    it(`captures only the exact approved legacy host receipt and checks its current authority: ${receipt}`, async () => {
      const initial = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'season', id: f.seasonA },
          game: {
            ...intent(),
            homeTeamId: f.teamB,
            awayTeamId: f.standaloneTeam
          },
          idempotencyKey: 'legacy-host-' + receipt
        },
        101
      )
      expect(initial.status).equals(201)
      const request = await initial.json()
      await f.h.db
        .updateTable('group_requests')
        .set({
          sender_id: userIdOfGumbo(102),
          sender_scope_type: 'team',
          sender_scope_id: f.teamB,
          terms: sql`terms - 'hostingAuthorizerUserId' - 'hostingAuthorizationSource'`
        })
        .where('id', '=', request.id)
        .execute()
      await f.h.db
        .updateTable('group_request_sides')
        .set({ approved_by: userIdOfGumbo(102), approved_at: f.clock.now() })
        .where('request_id', '=', request.id)
        .where('scope_id', '=', f.teamB)
        .execute()
      await f.h.db
        .insertInto('group_request_sides')
        .values({
          request_id: request.id,
          scope_type: 'season',
          scope_id: receipt === 'wrong-season' ? f.seasonB : f.seasonA,
          approved_by:
            receipt === 'unapproved'
              ? null
              : receipt === 'wrong-season'
                ? userIdOfGumbo(102)
                : userIdOfGumbo(101),
          approved_at: receipt === 'unapproved' ? null : f.clock.now()
        })
        .execute()
      await sql.raw(migration052SeasonGameRefinements.down).execute(f.h.db)
      await sql.raw(migration052SeasonGameRefinements.up).execute(f.h.db)
      const upgraded = await f.h.db
        .selectFrom('group_requests')
        .select('terms')
        .where('id', '=', request.id)
        .executeTakeFirstOrThrow()
      if (receipt === 'unapproved' || receipt === 'wrong-season')
        expect(upgraded.terms).not.property('hostingAuthorizerUserId')
      else
        expect(upgraded.terms).includes({
          hostingAuthorizerUserId: userIdOfGumbo(101),
          hostingAuthorizationSource: 'legacyReceipt'
        })
      if (receipt === 'revoked') await revokeHosting()
      if (receipt === 'disabled')
        await f.h.db
          .updateTable('users')
          .set({ disabled_at: f.clock.now() })
          .where('id', '=', userIdOfGumbo(101))
          .execute()
      const finish = await f.h.request(
        'POST',
        `/game-requests/${request.id}/accept`,
        {},
        103
      )
      expect(finish.status).equals(receipt === 'valid' ? 200 : 409)
      expect(await f.h.db.selectFrom('games').select('id').execute()).length(
        receipt === 'valid' ? 1 : 0
      )
      expect(
        await f.h.db
          .selectFrom('group_request_sides')
          .select('scope_type')
          .where('request_id', '=', request.id)
          .execute()
      ).deep.equals([{ scope_type: 'team' }, { scope_type: 'team' }])
    })
  it('lets a successor sending-team administrator resend a distinct replacement without original-team or hosting authority', async () => {
    const old = await published()
    await grant(f.teamA, 103)
    const made = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Successor Opponent',
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        },
        idempotencyKey: 'successor-opponent-team'
      },
      104
    )
    expect(made.status).equals(201)
    const other = (await made.json()).id
    const proposed = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.standaloneTeam },
        gameId: old,
        expected: gameVersion(materialGame(await row(old))),
        game: { ...intent(), homeTeamId: f.standaloneTeam, awayTeamId: other },
        idempotencyKey: 'successor-initial-replacement'
      },
      103
    )
    expect(proposed.status).equals(201)
    const original = await proposed.json()
    expect(original.status).equals('pending')
    expect((await row(old)).cancellation_reason).equals('replacement')
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamA,
      userIdOfGumbo(103),
      { admin: false, flags: [] },
      userIdOfGumbo(105)
    )
    await grant(f.standaloneTeam, 106)
    const fresh = await f.h.request(
      'POST',
      `/game-requests/${original.id}/resend`,
      { idempotencyKey: 'successor-replacement-resend' },
      106
    )
    expect(fresh.status).equals(201)
    const next = await fresh.json()
    expect(next).includes({ status: 'pending', replacesGameId: old })
    expect((await accept(next.id, 104)).status).equals('accepted')
    expect((await row(old)).status).equals('cancelled')
    expect(
      await f.h.db
        .selectFrom('notification_events')
        .select('id')
        .where('source_type', '=', 'gameReplacement')
        .execute()
    ).length(1)
  })
  it('resends an already authorized replacement hosting slot without current hosting rights and follows merged original opponent identities', async () => {
    const old = await published()
    const proposal = await replace(old, 'no-host-resend-original')
    const merged = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Merged Opponent',
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        },
        idempotencyKey: 'merged-anchor-opponent'
      },
      102
    )
    expect(merged.status).equals(201)
    const target = (await merged.json()).id
    await f.h.db
      .updateTable('teams')
      .set({ merged_into: target })
      .where('id', '=', f.teamB)
      .execute()
    await f.h.db
      .updateTable('games')
      .set({ away_team_id: target })
      .where('id', '=', old)
      .execute()
    await revokeHosting()
    const fresh = await f.h.request(
      'POST',
      `/game-requests/${proposal.id}/resend`,
      { idempotencyKey: 'no-host-resend-new' },
      101
    )
    expect(fresh.status).equals(201)
    const next = await fresh.json()
    const accepted = await accept(next.id, 103)
    expect(accepted.status).equals('accepted')
    expect((await row(accepted.gameId)).season_id).equals(f.seasonA)
    expect((await row(old)).status).equals('cancelled')
  })
  for (const corrupt of [
    'missing',
    'reason',
    'status',
    'season',
    'snapshot',
    'proposed-host'
  ] as const)
    it(`refuses replacement continuation with a ${corrupt} anchor without a successor or history mutation`, async () => {
      const old = await published()
      const proposal = await replace(old, 'bad-anchor-original-' + corrupt)
      if (corrupt === 'missing') {
        await f.h.db
          .updateTable('group_requests')
          .set({ game_id: null })
          .where('game_id', '=', old)
          .execute()
        await f.h.db.deleteFrom('games').where('id', '=', old).execute()
      } else if (corrupt === 'reason')
        await f.h.db
          .updateTable('games')
          .set({
            cancellation_reason: 'withdrawal',
            withdrawn_by_team_id: f.teamA,
            withdrawn_at: f.clock.now()
          })
          .where('id', '=', old)
          .execute()
      else if (corrupt === 'status')
        await f.h.db
          .updateTable('games')
          .set({ status: 'scheduled' })
          .where('id', '=', old)
          .execute()
      else if (corrupt === 'season')
        await f.h.db
          .updateTable('games')
          .set({ season_id: f.seasonB })
          .where('id', '=', old)
          .execute()
      else if (corrupt === 'snapshot')
        await f.h.db
          .updateTable('games')
          .set({ venue: 'Changed original snapshot' })
          .where('id', '=', old)
          .execute()
      else
        await f.h.db
          .updateTable('group_requests')
          .set({
            terms: sql`jsonb_set(terms, '{game,seasonId}', to_jsonb(${f.seasonB}::text))`
          })
          .where('id', '=', proposal.id)
          .execute()
      const before = await f.h.db
        .selectFrom('group_requests')
        .selectAll()
        .execute()
      const history = await f.h.db
        .selectFrom('notification_events')
        .selectAll()
        .execute()
      const result = await f.h.request(
        'POST',
        `/game-requests/${proposal.id}/resend`,
        { idempotencyKey: 'bad-anchor-new-' + corrupt },
        101
      )
      expect(result.status).equals(409)
      expect(
        await f.h.db.selectFrom('group_requests').selectAll().execute()
      ).deep.equals(before)
      expect(
        await f.h.db.selectFrom('notification_events').selectAll().execute()
      ).deep.equals(history)
    })
  it('rejects forged raw replacement context and blocks legacy retained requests that move the hosting season or lack original authority', async () => {
    const old = await published()
    const before = materialGame(await row(old))
    const forged = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: { ...intent(), seasonId: f.seasonB },
        resumedTerms: { gameId: null, replacesGameId: old, previous: before },
        idempotencyKey: 'forged-raw-continuation'
      },
      101
    )
    expect(forged.status).equals(403)
    const changed = await send(
      { ...intent(), venue: 'Legacy changed venue' },
      'legacy-host-move',
      old,
      gameVersion(before)
    )
    await f.h.db
      .updateTable('group_requests')
      .set({
        terms: sql`jsonb_set(terms, '{game,seasonId}', to_jsonb(${f.seasonB}::text))`
      })
      .where('id', '=', changed.id)
      .execute()
    const move = await f.h.request(
      'POST',
      `/game-requests/${changed.id}/accept`,
      {},
      102
    )
    expect(move.status).equals(409)
    expect(materialGame(await row(old))).deep.equals(before)
  })
  it('blocks retained publication after the sender loses both original teams even while controlling both proposed teams', async () => {
    const old = await published()
    const before = materialGame(await row(old))
    await grant(f.teamA, 103)
    await grant(f.teamB, 103)
    const made = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Retained Opponent',
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        },
        idempotencyKey: 'retained-opponent-team'
      },
      104
    )
    expect(made.status).equals(201)
    const other = (await made.json()).id
    const proposal = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.standaloneTeam },
        game: { ...intent(), homeTeamId: f.standaloneTeam, awayTeamId: other },
        gameId: old,
        expected: gameVersion(before),
        idempotencyKey: 'retained-original-authority'
      },
      103
    )
    expect(proposal.status).equals(201)
    const initial = await proposal.json()
    expect(initial).includes({
      status: 'pending',
      gameId: old,
      replacesGameId: null
    })
    for (const team of [f.teamA, f.teamB])
      await setScopeRoles(
        f.h.db,
        'team',
        team,
        userIdOfGumbo(103),
        { admin: false, flags: [] },
        userIdOfGumbo(105)
      )
    await grant(other, 103)
    const blocked = await f.h.request(
      'POST',
      `/game-requests/${initial.id}/accept`,
      {},
      103
    )
    expect(blocked.status).equals(409)
    expect(await blocked.json())
      .property('message')
      .includes('original team administrator')
    expect(materialGame(await row(old))).deep.equals(before)
    expect(
      await f.h.db
        .selectFrom('notification_events')
        .select('id')
        .where('source_type', '=', 'gameReplacement')
        .execute()
    ).length(0)
  })
  it('cancels an unmanaged removed opponent atomically, reserves a distinct ID, and informs its current administrators', async () => {
    const old = await published()
    const proposal = await replace(old)
    expect(proposal).includes({
      status: 'pending',
      gameId: null,
      replacesGameId: old
    })
    expect(proposal.proposedGameId).not.equals(old)
    expect(await row(old)).includes({
      status: 'cancelled',
      cancellation_reason: 'replacement',
      away_team_id: f.teamB
    })
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(1)
    const audit = await f.h.db
      .selectFrom('notification_events')
      .selectAll()
      .where('source_type', '=', 'gameReplacement')
      .executeTakeFirstOrThrow()
    expect(audit.recorded_recipients).includes(userIdOfGumbo(102))
    expect(audit.metadata).includes({
      originalGameId: old,
      replacementGameId: proposal.proposedGameId
    })
    const history = await f.h.request(
      'GET',
      '/me/notifications?history=1',
      undefined,
      102
    )
    expect(
      (await history.json()).items.some(
        (i: any) => i.type === 'gameReplacement'
      )
    ).equals(true)
    expect(
      (
        await f.h.request(
          'POST',
          `/game-requests/${proposal.id}/accept`,
          {},
          102
        )
      ).status
    ).equals(403)
    const saved = await accept(proposal.id, 103)
    expect(saved.gameId).equals(proposal.proposedGameId)
    expect(await row(saved.gameId)).includes({
      away_team_id: f.standaloneTeam,
      status: 'scheduled',
      home_score: null,
      away_score: null
    })
    expect((await row(old)).status).equals('cancelled')
  })
  it('serializes a replacement lineage before and after publication, preserving exact-key replay even after the published game is removed', async () => {
    const old = await published()
    const original = await replace(old, 'lineage-original')
    const path = `/game-requests/${original.id}/resend`
    const key = { idempotencyKey: 'lineage-first-resend' }
    const response = await f.h.request('POST', path, key, 101)
    expect(response.status).equals(201)
    const successor = await response.json()
    for (const idempotencyKey of [
      'lineage-second-resend',
      'lineage-third-resend'
    ]) {
      const blocked = await f.h.request('POST', path, { idempotencyKey }, 101)
      expect(blocked.status).equals(409)
      expect(await blocked.json())
        .property('message')
        .includes('newer invitation')
    }
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('supersedes_id', '=', original.id)
        .execute()
    ).length(1)
    const saved = await accept(successor.id, 103)
    expect(saved.status).equals('accepted')
    expect((await accept(successor.id, 103)).gameId).equals(saved.gameId)
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(2)
    expect(
      (
        await f.h.request(
          'POST',
          path,
          { idempotencyKey: 'lineage-after-publication' },
          101
        )
      ).status
    ).equals(409)
    const replay = await f.h.request('POST', path, key, 101)
    expect(replay.status).equals(201)
    expect(await replay.json()).includes({
      id: successor.id,
      status: 'accepted',
      gameId: saved.gameId
    })
    // Keep the accepted invitation as durable lineage history even if an operator removes its game.
    await f.h.db
      .updateTable('group_requests')
      .set({ game_id: null })
      .where('game_id', '=', saved.gameId)
      .execute()
    await f.h.db.deleteFrom('games').where('id', '=', saved.gameId).execute()
    expect(
      (
        await f.h.request(
          'POST',
          path,
          { idempotencyKey: 'lineage-after-removal' },
          101
        )
      ).status
    ).equals(409)
    expect((await row(old)).cancellation_reason).equals('replacement')
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(1)
  })
  it('permits at most one successor when two current sending-team administrators concurrently resend the same replacement', async () => {
    const old = await published()
    const original = await replace(old, 'concurrent-lineage-original')
    await grant(f.teamA, 106)
    const attempts = await Promise.all(
      [101, 106].map(async user => {
        const response = await f.h.request(
          'POST',
          `/game-requests/${original.id}/resend`,
          { idempotencyKey: 'concurrent-lineage-' + user },
          user
        )
        return { user, status: response.status, body: await response.json() }
      })
    )
    expect(
      attempts.map(attempt => attempt.status).sort((a, b) => a - b)
    ).deep.equals([201, 409])
    const successful = attempts.find(attempt => attempt.status === 201)!
    expect(
      await f.h.db
        .selectFrom('group_requests')
        .select('id')
        .where('supersedes_id', '=', original.id)
        .execute()
    ).length(1)
    expect((await accept(successful.body.id, 103)).status).equals('accepted')
    const replay = await f.h.request(
      'POST',
      `/game-requests/${original.id}/resend`,
      { idempotencyKey: 'concurrent-lineage-' + successful.user },
      successful.user
    )
    expect(replay.status).equals(201)
    expect(await replay.json()).includes({
      id: successful.body.id,
      status: 'accepted'
    })
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(2)
  })
  it('allows renewal of the current pending or closed replacement leaf while refusing every stale ancestor', async () => {
    const old = await published()
    const original = await replace(old, 'leaf-lineage-original')
    const resend = async (id: string, key: string): Promise<any> => {
      const response = await f.h.request(
        'POST',
        `/game-requests/${id}/resend`,
        { idempotencyKey: key },
        101
      )
      expect(response.status).equals(201)
      return await response.json()
    }
    const first = await resend(original.id, 'leaf-first')
    const second = await resend(first.id, 'leaf-second')
    for (const id of [original.id, first.id])
      expect(
        (
          await f.h.request(
            'POST',
            `/game-requests/${id}/resend`,
            { idempotencyKey: 'stale-pending-' + id },
            101
          )
        ).status
      ).equals(409)
    const declined = await f.h.request(
      'POST',
      `/game-requests/${second.id}/decline`,
      {},
      103
    )
    expect(declined.status).equals(200)
    expect(await resend(first.id, 'leaf-second')).includes({
      id: second.id,
      status: 'declined'
    })
    const third = await resend(second.id, 'leaf-third')
    expect(third.status).equals('pending')
    expect(
      (
        await f.h.request(
          'POST',
          `/game-requests/${second.id}/resend`,
          { idempotencyKey: 'stale-closed-leaf' },
          101
        )
      ).status
    ).equals(409)
    expect(await resend(second.id, 'leaf-third')).includes({
      id: third.id,
      status: 'pending'
    })
    const active = await f.h.db
      .selectFrom('group_requests')
      .select('id')
      .where('kind', '=', 'game')
      .where('status', '=', 'pending')
      .execute()
    expect(active).deep.equals([{ id: third.id }])
    expect((await accept(third.id, 103)).status).equals('accepted')
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(2)
  })
  for (const kind of ['new', 'retained'] as const)
    it(`rejects stale ${kind} ancestors while preserving their same-key result`, async () => {
      const old = kind === 'retained' ? await published() : undefined
      const initial =
        old == null
          ? await send(intent(), 'ordinary-lineage-new')
          : await send(
              { ...intent(), venue: 'Updated retained venue' },
              'ordinary-lineage-edit',
              old,
              gameVersion(materialGame(await row(old)))
            )
      const path = `/game-requests/${initial.id}/resend`
      const body = { idempotencyKey: 'ordinary-lineage-successor' }
      const response = await f.h.request('POST', path, body, 101)
      expect(response.status).equals(201)
      const successor = await response.json()
      expect(
        (
          await f.h.request(
            'POST',
            path,
            { idempotencyKey: 'ordinary-lineage-stale' },
            101
          )
        ).status
      ).equals(409)
      const accepted = await accept(successor.id, 102)
      expect(accepted.status).equals('accepted')
      if (old != null) expect(accepted.gameId).equals(old)
      expect(
        (
          await f.h.request(
            'POST',
            path,
            { idempotencyKey: 'ordinary-lineage-stale-published' },
            101
          )
        ).status
      ).equals(409)
      const replay = await f.h.request('POST', path, body, 101)
      expect(replay.status).equals(201)
      expect(await replay.json()).includes({
        id: successor.id,
        status: 'accepted',
        gameId: accepted.gameId
      })
      expect(await f.h.db.selectFrom('games').select('id').execute()).length(1)
    })
  it('keeps canceled originals after replacement decline, expiry, withdrawal and idempotent resend', async () => {
    const old = await published()
    const p = await replace(old)
    const declined = await f.h.request(
      'POST',
      `/game-requests/${p.id}/decline`,
      {},
      103
    )
    expect((await declined.json()).status).equals('declined')
    const resend = await f.h.request(
      'POST',
      `/game-requests/${p.id}/resend`,
      { idempotencyKey: 'resend-replacement' },
      101
    )
    expect(resend.status, await resend.clone().text()).equals(201)
    const fresh = await resend.json()
    expect(fresh.proposedGameId).equals(p.proposedGameId)
    expect(fresh.replacesGameId).equals(old)
    f.advance(7 * 24 * 3600 * 1000)
    expect((await accept(fresh.id, 103)).status).equals('expired')
    expect((await row(old)).status).equals('cancelled')
    expect(
      await f.h.db
        .selectFrom('notification_events')
        .select('id')
        .where('source_type', '=', 'gameReplacement')
        .execute()
    ).length(1)
    const resend2 = await f.h.request(
      'POST',
      `/game-requests/${fresh.id}/resend`,
      { idempotencyKey: 'resend-replacement-again' },
      101
    )
    const p2 = await resend2.json()
    expect(resend2.status).equals(201)
    expect(
      (
        await (
          await f.h.request('POST', `/game-requests/${p2.id}/withdraw`, {}, 101)
        ).json()
      ).status
    ).equals('cancelled')
    expect((await row(old)).status).equals('cancelled')
  })
  it('retains an original managed matchup until replacement consent, then updates the same event ID', async () => {
    const old = await published()
    await grant(f.teamB, 101)
    const p = await replace(old, 'managed-originals')
    expect(p).includes({
      status: 'pending',
      gameId: old,
      replacesGameId: null,
      proposedGameId: old
    })
    expect((await row(old)).away_team_id).equals(f.teamB)
    expect((await accept(p.id, 103)).gameId).equals(old)
    expect(await row(old)).includes({
      status: 'scheduled',
      away_team_id: f.standaloneTeam,
      cancellation_reason: null
    })
    expect(
      await f.h.db
        .selectFrom('notification_events')
        .select('id')
        .where('source_type', '=', 'gameReplacement')
        .execute()
    ).length(0)
  })
  it('updates a fully managed original and replacement in the same event without a cancellation', async () => {
    const old = await published()
    await grant(f.teamB, 101)
    await grant(f.standaloneTeam, 101)
    const saved = await replace(old, 'fully-managed-replacement')
    expect(saved).includes({
      status: 'accepted',
      gameId: old,
      proposedGameId: old,
      replacesGameId: null
    })
    expect(await row(old)).includes({
      away_team_id: f.standaloneTeam,
      status: 'scheduled',
      cancellation_reason: null
    })
  })
  it('revalidates the sender’s removal authority before retaining an event ID after replacement approval', async () => {
    const old = await published()
    await grant(f.teamB, 101)
    const proposal = await replace(old, 'retention-authority-waits')
    expect(proposal.gameId).equals(old)
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', userIdOfGumbo(101))
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', f.teamB)
      .execute()
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', userIdOfGumbo(101))
      .where('team_id', '=', f.teamB)
      .execute()
    const refused = await f.h.request(
      'POST',
      `/game-requests/${proposal.id}/accept`,
      {},
      103
    )
    expect(refused.status).equals(409)
    expect(await row(old)).includes({
      away_team_id: f.teamB,
      status: 'scheduled'
    })
    expect(
      (
        await f.h.request(
          'POST',
          `/game-requests/${proposal.id}/withdraw`,
          {},
          101
        )
      ).status
    ).equals(200)
    const resent = await f.h.request(
      'POST',
      `/game-requests/${proposal.id}/resend`,
      { idempotencyKey: 'retention-authority-fresh' },
      101
    )
    expect(resent.status).equals(201)
    const fresh = await resent.json()
    expect(fresh.replacesGameId).equals(old)
    expect(fresh.proposedGameId).not.equals(old)
    expect((await row(old)).cancellation_reason).equals('replacement')
    expect((await accept(fresh.id, 103)).gameId).equals(fresh.proposedGameId)
  })
  it('rolls back original cancellation and request identity when notification persistence fails', async () => {
    const old = await published()
    await sql`create function fail_replacement_fixture() returns trigger language plpgsql as $$ begin if new.source_type = 'gameReplacement' then raise exception 'fixture failure'; end if; return new; end $$; create trigger fail_replacement_fixture before insert on notification_events for each row execute function fail_replacement_fixture()`.execute(
      f.h.db
    )
    const response = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: { ...intent(), awayTeamId: f.standaloneTeam },
        gameId: old,
        expected: gameVersion(materialGame(await row(old))),
        idempotencyKey: 'rollback-replacement'
      },
      101
    )
    expect(response.status).equals(500)
    expect(await row(old)).includes({
      status: 'scheduled',
      cancellation_reason: null,
      away_team_id: f.teamB
    })
    expect(
      await f.h.db
        .selectFrom('creation_idempotency')
        .select('key')
        .where('key', '=', 'rollback-replacement')
        .execute()
    ).length(0)
    expect(
      await f.h.db.selectFrom('group_requests').select('id').execute()
    ).length(1)
  })
  it('migration preserves games and initializes independent defaults from their season while pruning obsolete approval sides', async () => {
    const p = await send(intent(), 'migration-pending')
    const saved = await accept(p.id, 102)
    const legacy = await send(
      { ...intent(), awayTeamId: f.standaloneTeam },
      'migration-legacy-new'
    )
    await sql`update group_requests set terms = terms - 'proposedGameId' - 'consentTeamIds' - 'replacesGameId' where id = ${legacy.id}`.execute(
      f.h.db
    )
    await f.h.db
      .updateTable('seasons')
      .set({ timezone: 'America/Los_Angeles' })
      .where('id', '=', f.seasonA)
      .execute()
    await f.h.db
      .insertInto('group_request_sides')
      .values([
        { request_id: p.id, scope_type: 'season', scope_id: f.seasonA },
        { request_id: p.id, scope_type: 'team', scope_id: f.standaloneTeam },
        { request_id: legacy.id, scope_type: 'season', scope_id: f.seasonA },
        { request_id: legacy.id, scope_type: 'team', scope_id: f.teamB }
      ])
      .execute()
    await sql.raw(migration052SeasonGameRefinements.down).execute(f.h.db)
    await sql.raw(migration052SeasonGameRefinements.up).execute(f.h.db)
    expect(await row(saved.gameId)).includes({
      exhibition: false,
      timezone: 'America/Los_Angeles',
      status: 'scheduled',
      home_team_id: f.teamA,
      away_team_id: f.teamB
    })
    const sides = await f.h.db
      .selectFrom('group_request_sides')
      .selectAll()
      .where('request_id', '=', p.id)
      .execute()
    expect(sides).length(4)
    expect(sides.some(side => side.scope_type === 'season')).equals(true)
    const pendingSides = await f.h.db
      .selectFrom('group_request_sides')
      .selectAll()
      .where('request_id', '=', legacy.id)
      .execute()
    expect(pendingSides).length(2)
    expect(pendingSides.every(side => side.scope_type === 'team')).equals(true)
    const terms = (
      await f.h.db
        .selectFrom('group_requests')
        .select('terms')
        .where('id', '=', legacy.id)
        .executeTakeFirstOrThrow()
    ).terms as { proposedGameId: string }
    expect(terms.proposedGameId).is.a('string')
    expect((await accept(legacy.id, 103)).gameId).equals(terms.proposedGameId)
  })
  it('saves fully managed replacement in place, swaps without cancellation, and creates a new event when only the removed team is unmanaged', async () => {
    const old = await published()
    await grant(f.standaloneTeam, 101)
    const newEvent = await replace(old, 'approved-new-matchup')
    expect(newEvent.status).equals('accepted')
    expect(newEvent.gameId).not.equals(old)
    const current = newEvent.gameId
    const swap = await send(
      { ...intent(), homeTeamId: f.standaloneTeam, awayTeamId: f.teamA },
      'swap-managed',
      current,
      gameVersion(materialGame(await row(current)))
    )
    expect(swap).includes({
      status: 'accepted',
      gameId: current,
      replacesGameId: null
    })
    expect((await row(current)).home_team_id).equals(f.standaloneTeam)
    const inplace = await send(
      { ...intent(), awayTeamId: f.standaloneTeam, venue: 'Demo Next Field' },
      'same-managed-set',
      current,
      gameVersion(materialGame(await row(current)))
    )
    expect(inplace.gameId).equals(current)
    expect((await row(current)).venue).equals('Demo Next Field')
  })
  it('retries produce one cancellation and reserved identity; mismatched retries and stale submissions cannot mutate history', async () => {
    const old = await published()
    const before = materialGame(await row(old))
    const body = {
      sender: { kind: 'team' as const, id: f.teamA },
      game: { ...before, awayTeamId: f.standaloneTeam },
      gameId: old,
      expected: gameVersion(before),
      idempotencyKey: 'retry-replacement'
    }
    const first = await proposeGame(f.h.db, actor(101), body, f.clock)
    const second = await proposeGame(f.h.db, actor(101), body, f.clock)
    expect(second.id).equals(first.id)
    expect(second.terms).deep.equals(first.terms)
    let failure: unknown
    try {
      await proposeGame(
        f.h.db,
        actor(101),
        { ...body, game: { ...body.game, venue: 'Different' } },
        f.clock
      )
    } catch (e) {
      failure = e
    }
    expect(failure).is.instanceOf(Error)
  })
  it('rejects stale, invalid, changed-season and played-game replacements before canceling anything', async () => {
    const old = await published()
    const version = gameVersion(materialGame(await row(old)))
    for (const change of [
      {
        expected: 'a'.repeat(64),
        game: { ...intent(), awayTeamId: f.standaloneTeam }
      },
      { expected: version, game: { ...intent(), awayTeamId: 'missing' } },
      {
        expected: version,
        game: { ...intent(), awayTeamId: f.standaloneTeam, seasonId: f.seasonB }
      }
    ]) {
      const r = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'team', id: f.teamA },
          gameId: old,
          idempotencyKey:
            'invalid-' +
            change.expected +
            change.game.awayTeamId +
            change.game.seasonId,
          ...change
        },
        101
      )
      expect(r.status).is.oneOf([400, 404, 409])
      expect((await row(old)).status).equals('scheduled')
    }
    await f.h.db
      .updateTable('games')
      .set({ status: 'inProgress' })
      .where('id', '=', old)
      .execute()
    const r = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        gameId: old,
        expected: version,
        game: { ...intent(), awayTeamId: f.standaloneTeam },
        idempotencyKey: 'played-replacement'
      },
      101
    )
    expect(r.status).equals(409)
    expect((await row(old)).status).equals('inProgress')
  })
  it('serializes racing replacements and withdraws without ever restoring a canceled event', async () => {
    const old = await published()
    const expected = gameVersion(materialGame(await row(old)))
    const body = {
      sender: { kind: 'team', id: f.teamA },
      gameId: old,
      expected,
      game: { ...intent(), awayTeamId: f.standaloneTeam }
    }
    const results = await Promise.all(
      ['race-one', 'race-two'].map(
        async key =>
          await f.h.request(
            'POST',
            '/game-requests',
            { ...body, idempotencyKey: key },
            101
          )
      )
    )
    expect(results.map(r => r.status).sort((a, b) => a - b)).deep.equals([
      201, 409
    ])
    const canceled = await withdrawFromGame(
      f.h.db,
      actor(102),
      old,
      f.teamB,
      f.clock
    )
    expect(canceled.cancellation_reason).equals('replacement')
    expect(
      await f.h.db
        .selectFrom('notification_events')
        .select('id')
        .where('source_type', '=', 'gameReplacement')
        .execute()
    ).length(1)
  })
  it('revalidates proposed-team authority and persists timezone/exhibition independently of custody', async () => {
    const p = await send(
      { ...intent(), exhibition: true },
      'pending-exhibition'
    )
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', userIdOfGumbo(101))
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', f.teamA)
      .execute()
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', userIdOfGumbo(101))
      .where('team_id', '=', f.teamA)
      .execute()
    await f.h.db
      .deleteFrom('season_team_parents')
      .where('team_id', '=', f.teamA)
      .execute()
    await f.h.db
      .updateTable('teams')
      .set({ league_id: null })
      .where('id', '=', f.teamA)
      .execute()
    expect((await accept(p.id, 102)).status).equals('pending')
    await grant(f.teamA, 104)
    const saved = await accept(p.id, 104)
    expect(await row(saved.gameId)).includes({
      exhibition: true,
      timezone: 'America/Los_Angeles'
    })
  })
  it('accepts legacy field-less versions only while migrated display/classification defaults remain unchanged', async () => {
    const old = await published()
    await f.h.db
      .updateTable('games')
      .set({ timezone: 'UTC' })
      .where('id', '=', old)
      .execute()
    await grant(f.teamB, 101)
    const canonical = materialGame(await row(old))
    const { timezone, exhibition, ...legacy } = canonical
    const legacyHash = createHash('sha256')
      .update(JSON.stringify(legacy))
      .digest('hex')
    const accepted = await send(
      { ...legacy, venue: 'Legacy Updated' },
      'legacy-version',
      old,
      legacyHash
    )
    expect(accepted.status).equals('accepted')
    await f.h.db
      .updateTable('games')
      .set({ exhibition: true })
      .where('id', '=', old)
      .execute()
    const stale = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: { ...legacy, venue: 'No stale save' },
        gameId: old,
        expected: legacyHash,
        idempotencyKey: 'stale-legacy-version'
      },
      101
    )
    expect(stale.status).equals(409)
  })
  it('cleans timezone/classification and updates batch metadata with both team authority but no host side', async () => {
    expect(asGameTimezone('America/Los_Angeles')).equals('America/Los_Angeles')
    for (const raw of [null, '', 'Not/AZone', 23])
      expect(() => asGameTimezone(raw)).throws(TypeError)
    expect(() =>
      asGameProposal({
        sender: { kind: 'team', id: f.teamA },
        game: { ...intent(), exhibition: 'yes' },
        idempotencyKey: 'bad-exhibition'
      })
    ).throws(TypeError)
    expect(() =>
      asScheduleGameRow({ startAt: intent().startAt, exhibition: 'yes' })
    ).throws(TypeError)
    await grant(f.teamB, 101)
    await setScopeRoles(
      f.h.db,
      'season',
      f.seasonB,
      userIdOfGumbo(101),
      { admin: true, flags: [] },
      userIdOfGumbo(105)
    )
    const first = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      actor: actor(101),
      rows: [
        {
          opponent: { teamId: f.teamB },
          side: 'home',
          seasonId: f.seasonB,
          startAt: intent().startAt,
          timezone: 'America/Los_Angeles',
          exhibition: true,
          externalId: { system: 'demo', id: 'batch-refine' }
        }
      ]
    })
    expect(first.results[0].result).equals('created')
    const id = (first.results[0] as any).gameId
    expect(await row(id)).includes({
      exhibition: true,
      timezone: 'America/Los_Angeles'
    })
    const second = await scheduleGames(f.h.db, {
      teamId: f.teamA,
      actor: actor(101),
      rows: [
        {
          startAt: intent().startAt,
          timezone: 'UTC',
          exhibition: false,
          externalId: { system: 'demo', id: 'batch-refine' }
        }
      ]
    })
    expect(second.results[0].result).equals('updated')
    expect(await row(id)).includes({ exhibition: false, timezone: 'UTC' })
  })
})
