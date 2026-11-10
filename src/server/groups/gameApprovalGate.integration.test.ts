import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { GameProposal } from '../../common/gameApprovals'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { roleScopes } from '../access'

describe('game approval readiness matches Express route semantics', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    await f.h.db
      .deleteFrom('system_settings')
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    await f.h.db
      .insertInto('season_teams')
      .values([
        { season_id: f.seasonA, team_id: f.teamA },
        { season_id: f.seasonA, team_id: f.teamB }
      ])
      .onConflict(oc => oc.columns(['season_id', 'team_id']).doNothing())
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  function proposal(key: string): GameProposal {
    return {
      sender: { kind: 'season', id: f.seasonA },
      game: {
        homeTeamId: f.teamA,
        awayTeamId: f.teamB,
        seasonId: f.seasonA,
        startAt: '2027-03-02T18:00:00Z',
        venue: null,
        outsideTournament: null,
        status: 'scheduled'
      },
      idempotencyKey: key
    }
  }
  it('refuses lowercase, uppercase, mixed-case and trailing-slash sends without publishing from legacy inherited rights', async () => {
    expect(
      (await roleScopes(f.h.db, userIdOfGumbo(101), false)).admin.teamIds.has(
        f.teamB
      )
    ).equals(true)
    for (const path of [
      '/game-requests',
      '/GAME-REQUESTS',
      '/GaMe-ReQuEsTs',
      '/GAME-REQUESTS/'
    ]) {
      expect(
        (await f.h.request('POST', path, proposal('demo-blocked-' + path), 101))
          .status,
        path
      ).equals(503)
    }
    expect(
      await f.h.db.selectFrom('group_requests').select('id').execute()
    ).length(0)
    expect(await f.h.db.selectFrom('games').select('id').execute()).length(0)
  })
  it('guards every request decision, feed, schedule hide, scheduling read and withdrawal variant before looking up the entity', async () => {
    for (const [method, path] of [
      ['GET', '/GAME-REQUESTS/?scopeKind=season&scopeId=' + f.seasonA],
      ['POST', '/GAME-REQUESTS/inv_demo/ACCEPT/'],
      ['POST', '/GAME-REQUESTS/inv_demo/DECLINE/'],
      ['POST', '/GAME-REQUESTS/inv_demo/WITHDRAW/'],
      ['POST', '/GAME-REQUESTS/inv_demo/RESEND/'],
      ['DELETE', '/GAME-REQUESTS/inv_demo/SCHEDULE-ENTRY/'],
      ['GET', '/GAMES/gam_demo/SCHEDULING/'],
      ['POST', '/GAMES/gam_demo/WITHDRAWALS/']
    ])
      expect(
        (
          await f.h.request(
            method,
            path,
            method === 'GET' ? undefined : {},
            101
          )
        ).status,
        path
      ).equals(503)
    expect(
      (await f.h.request('GET', '/game-requests-unrelated', undefined, 101))
        .status
    ).equals(404)
  })
  it('preserves case-insensitive routing after cutover, requires the true guest administrator and shares the resulting game', async () => {
    await f.h.db
      .insertInto('system_settings')
      .values({ key: 'creation.hierarchyReady', value: true })
      .execute()
    expect(
      (await roleScopes(f.h.db, userIdOfGumbo(101), false)).admin.teamIds.has(
        f.teamB
      )
    ).equals(false)
    // A guest outside the season still needs its own administrator's consent.
    await f.h.db
      .deleteFrom('season_teams')
      .where('season_id', '=', f.seasonA)
      .where('team_id', '=', f.teamB)
      .execute()
    const sent = await f.h.request(
      'POST',
      '/GAME-REQUESTS/',
      proposal('demo-enabled-game'),
      101
    )
    expect(sent.status).equals(201)
    const pending = (await sent.json()) as {
      id: string
      status: string
      gameId: string | null
    }
    expect(pending).includes({ status: 'pending', gameId: null })
    expect(
      (
        await f.h.request(
          'POST',
          `/GAME-REQUESTS/${pending.id}/ACCEPT/`,
          {},
          103
        )
      ).status
    ).equals(403)
    const senderConsent = await f.h.request(
      'POST',
      `/GAME-REQUESTS/${pending.id}/ACCEPT/`,
      {},
      101
    )
    expect(senderConsent.status).equals(200)
    expect(await senderConsent.json()).includes({
      status: 'pending',
      gameId: null
    })
    const accepted = await f.h.request(
      'POST',
      `/GAME-REQUESTS/${pending.id}/ACCEPT/`,
      {},
      102
    )
    expect(accepted.status).equals(200)
    const game = (await accepted.json()) as { status: string; gameId: string }
    expect(game.status).equals('accepted')
    expect(
      (
        await f.h.request(
          'GET',
          `/GAMES/${game.gameId}/SCHEDULING/`,
          undefined,
          101
        )
      ).status
    ).equals(200)
    expect(
      (
        await f.h.request(
          'POST',
          `/GAMES/${game.gameId}/WITHDRAWALS/`,
          { teamId: f.teamB },
          102
        )
      ).status
    ).equals(200)
    expect(
      await f.h.db
        .selectFrom('games')
        .select(['status', 'withdrawn_by_team_id'])
        .where('id', '=', game.gameId)
        .executeTakeFirstOrThrow()
    ).deep.equals({ status: 'cancelled', withdrawn_by_team_id: f.teamB })
  })
})
