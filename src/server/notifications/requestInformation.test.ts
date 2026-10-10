import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('invitation display snapshots', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const information = async (
    id: string,
    user: number
  ): Promise<{ title: string; description: string }> => {
    const response = await f.h.request(
      'GET',
      `/me/notifications/${id}`,
      undefined,
      user
    )
    expect(response.status).equals(200)
    const { title, description } = (await response.json()) as {
      title: string
      description: string
    }
    return { title, description }
  }
  it('preserves game opponent/host names and display zone in pending and resolved history after renames', async () => {
    const sent = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          venue: 'Demo Original Park',
          status: 'scheduled'
        },
        idempotencyKey: 'snapshot-game'
      },
      101
    )
    expect(sent.status).equals(201)
    const { id } = (await sent.json()) as { id: string }
    const before = await information(id, 102)
    expect(before.title).includes('Demo Eagles')
    expect(before.description).includes('UTC')
    expect(
      (
        await f.h.request(
          'PUT',
          `/groups/team/${f.teamB}`,
          { name: 'Demo Renamed Eagles' },
          102
        )
      ).status
    ).equals(200)
    expect(
      (
        await f.h.request(
          'PUT',
          `/groups/season/${f.seasonA}`,
          { name: 'Demo Renamed Regular', timezone: 'America/New_York' },
          101
        )
      ).status
    ).equals(200)
    expect(await information(id, 102)).deep.equals(before)
    expect(
      await (
        await f.h.request('POST', `/game-requests/${id}/accept`, {}, 102)
      ).json()
    ).property('status', 'accepted')
    expect(await information(id, 102)).deep.equals(before)
  })
  it('shows proposed and previous exhibition classification and material display zones through the real notification endpoint', async () => {
    const game = {
      homeTeamId: f.teamA,
      awayTeamId: f.teamB,
      seasonId: f.seasonA,
      startAt: '2027-04-01T19:00:00Z',
      venue: 'Demo Park',
      status: 'scheduled'
    }
    const sent = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game,
        idempotencyKey: 'exhibition-display-original'
      },
      101
    )
    expect(sent.status).equals(201)
    const original = await sent.json()
    const accepted = await f.h.request(
      'POST',
      `/game-requests/${original.id}/accept`,
      {},
      102
    )
    expect(accepted.status).equals(200)
    const gameId = (await accepted.json()).gameId
    const scheduling = await f.h.request(
      'GET',
      `/games/${gameId}/scheduling`,
      undefined,
      101
    )
    expect(scheduling.status).equals(200)
    const current = await scheduling.json()
    for (const [key, changed] of [
      ['classification-only', { ...current.game, exhibition: true }],
      ['zone-only', { ...current.game, timezone: 'America/Los_Angeles' }]
    ] as const) {
      const revision = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'team', id: f.teamA },
          gameId,
          expected: current.version,
          game: changed,
          idempotencyKey: 'material-display-' + key
        },
        101
      )
      expect(revision.status).equals(201)
      const proposal = await revision.json()
      const shown = await information(proposal.id, 102)
      const [proposed, previous] = shown.description.split('Previously')
      expect(proposed).includes(
        key === 'classification-only' ? 'Exhibition: On' : 'Exhibition: Off'
      )
      expect(previous).includes('Exhibition: Off')
      expect(previous).includes('(UTC)')
      expect(proposed).includes(
        key === 'zone-only' ? '(America/Los_Angeles)' : '(UTC)'
      )
      const declined = await f.h.request(
        'POST',
        `/game-requests/${proposal.id}/decline`,
        {},
        102
      )
      expect(declined.status).equals(200)
      expect(await information(proposal.id, 102)).deep.equals(shown)
    }
  })
  it('adds legacy false classification to cached descriptions without replacing frozen names or duplicating it', async () => {
    const sent = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          status: 'scheduled'
        },
        idempotencyKey: 'legacy-display-classification'
      },
      101
    )
    expect(sent.status).equals(201)
    const original = await sent.json()
    const accepted = await f.h.request(
      'POST',
      `/game-requests/${original.id}/accept`,
      {},
      102
    )
    expect(accepted.status).equals(200)
    const gameId = (await accepted.json()).gameId
    const scheduling = await (
      await f.h.request('GET', `/games/${gameId}/scheduling`, undefined, 101)
    ).json()
    const revision = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        gameId,
        expected: scheduling.version,
        game: { ...scheduling.game, venue: 'Demo Legacy Revision Field' },
        idempotencyKey: 'legacy-cached-revision'
      },
      101
    )
    expect(revision.status).equals(201)
    const { id } = await revision.json()
    await f.h.db
      .updateTable('group_requests')
      .set({
        terms: sql`jsonb_set(jsonb_set(terms, '{game}', (terms->'game') - 'exhibition' - 'timezone'), '{previous}', (terms->'previous') - 'exhibition' - 'timezone')`
      })
      .where('id', '=', id)
      .execute()
    await f.h.db
      .updateTable('notification_events')
      .set({
        metadata: sql`(metadata - 'gameClassificationIncluded') || jsonb_build_object('requestDescription', 'Frozen legacy names and game details.')`
      })
      .where('source_id', '=', id)
      .execute()
    const shown = await information(id, 102)
    expect(shown.description).equals(
      'Frozen legacy names and game details. Proposed Exhibition: Off. Previous Exhibition: Off.'
    )
    await f.h.db
      .updateTable('teams')
      .set({ name: 'Demo Current Renamed Team' })
      .where('id', '=', f.teamA)
      .execute()
    expect(await information(id, 102)).deep.equals(shown)
  })
  for (const kind of ['participation', 'parent', 'person'] as const)
    it(`preserves ${kind} target and organizing context after group renames`, async () => {
      const response =
        kind === 'person'
          ? await f.h.request(
              'POST',
              `/manage/team/${f.teamA}/people`,
              {
                email: 'fixture106@example.com',
                admin: false,
                flags: ['coach'],
                idempotencyKey: 'snapshot-person'
              },
              101
            )
          : await f.h.request(
              'POST',
              '/relationship-requests',
              kind === 'parent'
                ? {
                    kind,
                    sender: { kind: 'league', id: f.leagueB },
                    actions: [
                      {
                        operation: 'attach',
                        child: { kind: 'season', id: f.standaloneSeason },
                        parent: { kind: 'league', id: f.leagueB }
                      }
                    ],
                    idempotencyKey: 'snapshot-parent'
                  }
                : {
                    kind,
                    sender: { kind: 'season', id: f.seasonB },
                    teamId: f.teamA,
                    seasonId: f.seasonB,
                    idempotencyKey: 'snapshot-participation'
                  },
              102
            )
      expect(response.status).equals(201)
      const body = (await response.json()) as {
        id?: string
        invited?: { requestId: string }
      }
      const id = kind === 'person' ? body.invited!.requestId : body.id!
      const user = kind === 'person' ? 106 : kind === 'parent' ? 103 : 101
      const before = await information(id, user)
      for (const [groupKind, groupId, administrator] of [
        ['team', f.teamA, 101],
        ['season', f.seasonB, 102],
        ['league', f.leagueB, 102],
        ['season', f.standaloneSeason, 103]
      ] as const)
        expect(
          (
            await f.h.request(
              'PUT',
              `/groups/${groupKind}/${groupId}`,
              { name: `Demo Renamed ${groupKind}` },
              administrator
            )
          ).status
        ).equals(200)
      expect(await information(id, user)).deep.equals(before)
      expect(
        await (
          await f.h.request(
            'POST',
            `/relationship-requests/${id}/accept`,
            {},
            user
          )
        ).json()
      ).property('status', 'accepted')
      expect(await information(id, user)).deep.equals(before)
    })
})
