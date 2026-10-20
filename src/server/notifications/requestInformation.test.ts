import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { grantInformation, roleList } from './requestInformation'

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
  it('freezes proposed and previous notes/arrival, including omitted fields and deliberate clears, before consent', async () => {
    const initial = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          status: 'scheduled',
          notes: 'Field 1',
          arrivalTimeDelta: 45
        },
        idempotencyKey: 'event-details-snapshot-original'
      },
      101
    )
    expect(initial.status).equals(201)
    const { id: originalId } = await initial.json()
    const accepted = await f.h.request(
      'POST',
      `/game-requests/${originalId}/accept`,
      {},
      102
    )
    expect(accepted.status).equals(200)
    const { gameId } = await accepted.json()
    const current = await (
      await f.h.request('GET', `/games/${gameId}/scheduling`, undefined, 101)
    ).json()
    for (const [key, changed, note, arrival] of [
      [
        'notes',
        { notes: 'Field 2\nMeet by gate' },
        'Field 2\nMeet by gate',
        '45 minutes before start'
      ],
      ['arrival', { arrivalTimeDelta: 0 }, 'Field 1', '0 minutes before start'],
      [
        'one-minute',
        { arrivalTimeDelta: 1 },
        'Field 1',
        '1 minute before start'
      ],
      [
        'omitted',
        {
          notes: undefined,
          arrivalTimeDelta: undefined,
          venue: 'Demo Revision Park'
        },
        'Field 1',
        '45 minutes before start'
      ],
      [
        'cleared',
        { notes: null, arrivalTimeDelta: null },
        'Not set (cleared)',
        'Not set (cleared)'
      ]
    ] as const) {
      const sent = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'team', id: f.teamA },
          gameId,
          expected: current.version,
          game: { ...current.game, ...changed },
          idempotencyKey: `event-details-snapshot-${key}`
        },
        101
      )
      expect(sent.status).equals(201)
      const { id } = await sent.json()
      let shown = await information(id, 102)
      expect(shown.description)
        .includes(`Proposed notes: ${note}.`)
        .and.includes('Previous notes: Field 1.')
        .and.includes(`Proposed arrival: ${arrival}.`)
        .and.includes('Previous arrival: 45 minutes before start.')
      if (key === 'cleared') {
        await f.h.db
          .updateTable('notification_events')
          .set({
            metadata: sql`(metadata - 'gameEventDetailsIncluded') || jsonb_build_object('requestDescription', 'Frozen game names and details.')`
          })
          .where('source_id', '=', id)
          .execute()
        shown = await information(id, 102)
        expect(
          shown.description.startsWith('Frozen game names and details.')
        ).equals(true)
        expect(shown.description)
          .includes('Proposed notes: Not set (cleared).')
          .and.includes('Proposed arrival: Not set (cleared).')
        expect(shown.description.match(/Proposed notes:/g)).length(1)
        expect(await information(id, 102)).deep.equals(shown)
      }
      await f.h.db
        .updateTable('teams')
        .set({ name: 'Demo Renamed Snapshot Team' })
        .where('id', '=', f.teamA)
        .execute()
      expect(await information(id, 102)).deep.equals(shown)
      const resolved = await f.h.request(
        'POST',
        `/game-requests/${id}/${key === 'cleared' ? 'accept' : 'decline'}`,
        {},
        102
      )
      expect(resolved.status).equals(200)
      expect(await information(id, 102)).deep.equals(shown)
    }
    const saved = await f.h.db
      .selectFrom('games')
      .select(['notes', 'arrival_time_delta'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(saved).deep.equals({ notes: null, arrival_time_delta: null })
  })
  it('freezes address and end changes, omitted values and clears before consent', async () => {
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
          endAt: '2027-04-01T22:00:00Z',
          timezone: 'America/Los_Angeles',
          address: '1 Demo Way',
          status: 'scheduled'
        },
        idempotencyKey: 'schedule-details-original'
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
    const { gameId } = await accepted.json()
    const current = await (
      await f.h.request('GET', `/games/${gameId}/scheduling`, undefined, 101)
    ).json()
    for (const [key, changed, address, end] of [
      [
        'address',
        { address: '2 Demo Way' },
        '2 Demo Way',
        'Apr 1, 2027, 3:00 PM (America/Los_Angeles)'
      ],
      [
        'end',
        { endAt: '2027-04-02T01:00:00Z' },
        '1 Demo Way',
        'Apr 1, 2027, 6:00 PM (America/Los_Angeles)'
      ],
      [
        'omitted',
        { address: undefined, endAt: undefined, venue: 'Demo Updated Park' },
        '1 Demo Way',
        'Apr 1, 2027, 3:00 PM (America/Los_Angeles)'
      ],
      [
        'cleared',
        { address: null, endAt: null },
        'Not set (cleared)',
        'Not set (defaults to three hours after start) (cleared)'
      ]
    ] as const) {
      const response = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'team', id: f.teamA },
          gameId,
          expected: current.version,
          game: { ...current.game, ...changed },
          idempotencyKey: `schedule-details-${key}`
        },
        101
      )
      expect(response.status).equals(201)
      const { id } = await response.json()
      let shown = await information(id, 102)
      expect(shown.description)
        .includes(`Proposed address: ${address}.`)
        .and.includes('Previous address: 1 Demo Way.')
        .and.includes(`Proposed end: ${end}.`)
        .and.includes(
          'Previous end: Apr 1, 2027, 3:00 PM (America/Los_Angeles).'
        )
      if (key === 'cleared') {
        await f.h.db
          .updateTable('notification_events')
          .set({
            metadata: sql`(metadata - 'gameScheduleDetailsIncluded') || jsonb_build_object('requestDescription', 'Frozen names, notes and arrival.')`
          })
          .where('source_id', '=', id)
          .execute()
        shown = await information(id, 102)
        expect(shown.description)
          .includes('Frozen names, notes and arrival.')
          .and.includes(`Proposed address: ${address}.`)
          .and.includes(`Proposed end: ${end}.`)
        expect(shown.description.match(/Proposed end:/g)).length(1)
      }
      await f.h.db
        .updateTable('teams')
        .set({ name: 'Demo Renamed Schedule Team' })
        .where('id', '=', f.teamA)
        .execute()
      expect(await information(id, 102)).deep.equals(shown)
      expect(
        (
          await f.h.request(
            'POST',
            `/game-requests/${id}/${key === 'cleared' ? 'accept' : 'decline'}`,
            {},
            102
          )
        ).status
      ).equals(200)
      expect(await information(id, 102)).deep.equals(shown)
    }
    expect(
      await f.h.db
        .selectFrom('games')
        .select(['address', 'end_at'])
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
    ).deep.equals({ address: null, end_at: null })
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
                // An address nobody holds yet, so it waits as an invitation.
                email: 'snapshot-person@example.com',
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
      // The address is Tim Raines's afterwards, who reads and accepts it.
      if (kind === 'person')
        await f.h.db
          .insertInto('user_emails')
          .values({
            id: 'email_snapshot_person',
            user_id: userIdOfGumbo(106),
            email: 'snapshot-person@example.com',
            verified_at: new Date()
          })
          .execute()
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

describe('what a grant\u2019s notification says', () => {
  it('names who added them, as what and to what', () => {
    expect(grantInformation('Dana Lee', 'Owls', [])).deep.equals({
      title: 'Dana Lee added you to Owls',
      description:
        "You are a member of Owls now. If you don't want to be, leave it here."
    })
    expect(grantInformation('Dana Lee', 'Owls', ['coach']).title).equals(
      'Dana Lee added you as Coach of Owls'
    )
    expect(roleList(['admin', 'coach', 'videographer'])).equals(
      'Admin, Coach and Videographer'
    )
    expect(roleList(['assistant', 'scorekeeper', 'songkeeper'])).equals(
      'Assistant, Scorekeeper and Songkeeper'
    )
  })
})
