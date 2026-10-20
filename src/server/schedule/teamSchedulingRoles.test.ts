import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { canScheduleFor } from '../groups/rights'

describe('team scheduling by coaches and assistants', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('scope_roles')
      .values([
        {
          id: 'role_schedule_coach',
          scope_type: 'team',
          scope_id: f.teamA,
          user_id: userIdOfGumbo(103),
          role: 'coach'
        },
        {
          id: 'role_schedule_assistant',
          scope_type: 'team',
          scope_id: f.teamA,
          user_id: userIdOfGumbo(104),
          role: 'assistant'
        },
        {
          id: 'role_schedule_scorekeeper',
          scope_type: 'team',
          scope_id: f.teamA,
          user_id: userIdOfGumbo(106),
          role: 'scorekeeper'
        }
      ])
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    user = 103,
    events = false
  ): Promise<{
    status: number
    body: {
      id: string
      gameId: string
      version: string
      items: Array<{ requestId: string; canAct: boolean }>
    }
  }> => {
    const response = await f.h.request(method, path, body, user)
    const value = (await response.json()) as {
      id: string
      gameId: string
      version: string
      items: Array<{ requestId: string; canAct: boolean }>
    }
    const dir = process.env.TS_SETTINGS_ARTIFACTS
    if (dir != null) {
      await mkdir(dir, { recursive: true })
      await appendFile(
        join(dir, events ? 'team-events-coach.log' : 'game-requests-coach.log'),
        `$ HTTP ${method} ${path} actor=${user} ${body == null ? '' : JSON.stringify(body)}\n${response.status} ${JSON.stringify(value)}\n`
      )
    }
    return { status: response.status, body: value }
  }
  const proposal = (
    sender = f.teamA,
    home = f.teamA,
    away = f.teamB,
    key = 'schedule-proposal'
  ): Record<string, unknown> => ({
    sender: { kind: 'team', id: sender },
    idempotencyKey: key,
    game: {
      homeTeamId: home,
      awayTeamId: away,
      seasonId: null,
      startAt: '2027-04-10T18:00:00.000Z',
      venue: null,
      status: 'scheduled'
    }
  })
  for (const user of [101, 103, 104])
    it(`lets ${user === 101 ? 'an administrator' : user === 103 ? 'a coach' : 'an assistant'} propose, resend, withdraw and edit its team events`, async () => {
      const sent = await request('POST', '/game-requests', proposal(), user)
      expect(sent.status).equals(201)
      expect(
        (
          await request(
            'POST',
            `/game-requests/${sent.body.id}/decline`,
            {},
            102
          )
        ).status
      ).equals(200)
      const resent = await request(
        'POST',
        `/game-requests/${sent.body.id}/resend`,
        { idempotencyKey: 'schedule-resend' },
        user
      )
      expect(resent.status).equals(201)
      expect(
        (
          await request(
            'POST',
            `/game-requests/${resent.body.id}/withdraw`,
            {},
            user
          )
        ).status
      ).equals(200)
      const event = await request(
        'POST',
        '/events',
        {
          teamId: f.teamA,
          eventType: 'practice',
          title: 'Practice',
          startAt: '2027-04-10T18:00:00.000Z',
          timezone: 'UTC',
          idempotencyKey: 'staff-practice'
        },
        user,
        true
      )
      expect(event.status).equals(201)
      expect(
        (
          await request(
            'PUT',
            `/events/${event.body.id}/info`,
            { notes: 'Team drills' },
            user,
            true
          )
        ).status
      ).equals(200)
    })
  for (const user of [103, 104])
    it(`shows incoming proposals to staff ${user} and lets them accept and leave the scheduled game`, async () => {
      const sent = await request(
        'POST',
        '/game-requests',
        proposal(f.teamB, f.teamB, f.teamA),
        102
      )
      expect(sent.status).equals(201)
      const inbox = await request('GET', '/me/notifications', undefined, user)
      expect(
        inbox.body.items.some(
          (row: { requestId: string; canAct: boolean }) =>
            row.requestId === sent.body.id && row.canAct
        )
      ).equals(true)
      const accepted = await request(
        'POST',
        `/game-requests/${sent.body.id}/accept`,
        {},
        user
      )
      expect(accepted.status).equals(200)
      const gameId = accepted.body.gameId
      expect(gameId).a('string')
      const scheduling = await request(
        'GET',
        `/games/${gameId}/scheduling`,
        undefined,
        user
      )
      expect(scheduling.status).equals(200)
      const edit = await request(
        'POST',
        '/game-requests',
        {
          ...proposal(f.teamA, f.teamB, f.teamA, 'staff-edit'),
          gameId,
          expected: scheduling.body.version
        },
        user
      )
      expect(edit.status).equals(201)
      expect(
        (
          await request(
            'POST',
            `/game-requests/${edit.body.id}/withdraw`,
            {},
            user
          )
        ).status
      ).equals(200)
      const declining = await request(
        'POST',
        '/game-requests',
        proposal(f.teamB, f.teamB, f.teamA, 'staff-decline'),
        102
      )
      expect(declining.status).equals(201)
      expect(
        (
          await request(
            'POST',
            `/game-requests/${declining.body.id}/decline`,
            {},
            user
          )
        ).status
      ).equals(200)
      expect(
        (
          await request(
            'POST',
            `/games/${gameId}/withdrawals`,
            { teamId: f.teamA },
            user
          )
        ).status
      ).equals(200)
    })
  it('allows an inherited coach and retains administrator authority for a season source', async () => {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'role_schedule_inherited',
        scope_type: 'season',
        scope_id: f.seasonA,
        user_id: userIdOfGumbo(106),
        role: 'coach'
      })
      .execute()
    expect(
      await canScheduleFor(f.h.db, actor(106), { kind: 'team', id: f.teamA })
    ).equals(true)
    expect(
      await canScheduleFor(f.h.db, actor(106), {
        kind: 'season',
        id: f.seasonA
      })
    ).equals(false)
    expect(
      (await request('POST', '/game-requests', proposal(), 106)).status
    ).equals(201)
    expect(
      (
        await request(
          'POST',
          '/events',
          {
            teamId: f.teamA,
            eventType: 'practice',
            title: 'Practice',
            startAt: '2027-04-10T18:00:00.000Z',
            timezone: 'UTC',
            idempotencyKey: 'inherited-practice'
          },
          106,
          true
        )
      ).status
    ).equals(201)
    expect(
      (
        await request(
          'POST',
          '/game-requests',
          {
            ...proposal(),
            idempotencyKey: 'refused-season-source',
            sender: { kind: 'season', id: f.seasonA }
          },
          106
        )
      ).status
    ).equals(403)
  })
  it('requires a participating team scheduler and refuses representing an unmanaged inviting team', async () => {
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', userIdOfGumbo(103))
      .where('scope_id', '=', f.teamA)
      .execute()
    const unrelatedSource = await request(
      'POST',
      '/game-requests',
      proposal(f.standaloneTeam, f.teamA, f.teamB, 'unrelated-source'),
      103
    )
    expect(unrelatedSource.status).equals(403)
    const unmanagedInitiator = await request(
      'POST',
      '/game-requests',
      {
        ...proposal(f.teamB, f.teamB, f.standaloneTeam, 'unmanaged-initiator'),
        sender: { kind: 'season', id: f.seasonA },
        initiatingTeamId: f.teamB
      },
      101
    )
    expect(unmanagedInitiator.status).equals(403)
  })
  it('refuses scorekeepers, unrelated team administrators and revoked coaching rights', async () => {
    for (const user of [106, 102]) {
      expect(
        (await request('POST', '/game-requests', proposal(), user)).status
      ).equals(403)
      expect(
        (
          await request(
            'POST',
            '/events',
            {
              teamId: f.teamA,
              title: 'Drills',
              startAt: '2027-04-10T18:00:00.000Z',
              idempotencyKey: 'refused-event'
            },
            user,
            true
          )
        ).status
      ).oneOf([403, 404])
    }
    await f.h.db
      .deleteFrom('scope_roles')
      .where('user_id', '=', userIdOfGumbo(103))
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', f.teamA)
      .execute()
    expect(
      (await request('POST', '/game-requests', proposal(), 103)).status
    ).equals(403)
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_plain_scheduler',
        user_id: userIdOfGumbo(103),
        team_id: f.teamA,
        role: 'member',
        is_player: false
      })
      .execute()
    expect(
      (
        await request(
          'POST',
          '/events',
          {
            teamId: f.teamA,
            eventType: 'practice',
            title: 'Practice',
            startAt: '2027-04-10T18:00:00.000Z',
            timezone: 'UTC',
            idempotencyKey: 'plain-member-practice'
          },
          103,
          true
        )
      ).status
    ).equals(403)
  })
})
