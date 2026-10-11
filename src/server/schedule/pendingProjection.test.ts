import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { publicGames } from '../groups/publicSummary'
import { scheduleOf } from '../routes/seasons'
import { pendingSchedule } from './pendingProjection'

describe('scoped pending schedules and request-local authority', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  const send = async (index: string, unrelated = false): Promise<string> => {
    const response = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: unrelated ? f.seasonB : f.seasonA },
        game: {
          homeTeamId: unrelated ? f.teamB : f.teamA,
          awayTeamId: unrelated ? f.standaloneTeam : f.teamB,
          seasonId: unrelated ? f.seasonB : f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          venue: 'Demo Park',
          status: 'scheduled'
        },
        idempotencyKey: 'pending-query-' + index
      },
      unrelated ? 102 : 101
    )
    expect(response.status).equals(201)
    return (await response.json()).id
  }
  const measured = (): {
    db: typeof f.h.db
    reset: () => void
    counts: () => { queries: number; selectedRequests: number }
  } => {
    let queries = 0
    let selectedRequests = 0
    return {
      db: f.h.db.withPlugin({
        transformQuery(args) {
          return args.node
        },
        async transformResult(args) {
          queries++
          selectedRequests += args.result.rows.filter(
            row => 'terms' in row && 'sender_scope_type' in row
          ).length
          return args.result
        }
      }),
      reset: () => {
        queries = 0
        selectedRequests = 0
      },
      counts: () => ({ queries, selectedRequests })
    }
  }
  it('does not select or authorize twenty unrelated requests for scoped, global-owned, public, or published-only reads', async () => {
    const related = await send('related')
    const m = measured()
    const read = async (): Promise<
      Array<{ queries: number; selectedRequests: number }>
    > => {
      const counts = []
      for (const lookup of [
        { teamId: f.teamA },
        { seasonIds: [f.seasonA] },
        undefined
      ]) {
        m.reset()
        const result = await pendingSchedule(
          m.db,
          actor(101),
          f.clock.now(),
          lookup
        )
        expect(result.map(row => row.pendingRequestId)).deep.equals([related])
        counts.push(m.counts())
      }
      m.reset()
      const publicRows = await publicGames(m.db, { kind: 'team', id: f.teamA })
      expect(publicRows).length(1)
      expect(publicRows[0].pendingRequestId).equals(null)
      counts.push(m.counts())
      m.reset()
      expect(
        await pendingSchedule(m.db, actor(101), f.clock.now(), {
          publishedGameIds: ['unrelated-published-id'],
          includeNew: false
        })
      ).deep.equals([])
      counts.push(m.counts())
      return counts
    }
    const before = await read()
    for (let index = 0; index < 20; index++) await send('noise-' + index, true)
    const after = await read()
    expect(after).deep.equals(before)
    for (const count of after) {
      expect(count.queries).at.most(32)
      expect(count.selectedRequests).at.most(1)
    }
    console.info(
      'Pending lookup query counts scoped/global/public/detail:',
      after.map(count => count.queries).join('/')
    )
    m.reset()
    expect(await pendingSchedule(m.db, actor(105), f.clock.now())).length(21)
    expect(m.counts().queries).at.most(32)
    m.reset()
    expect(
      await pendingSchedule(m.db, actor(101), f.clock.now(), {
        publishedGameIds: [],
        includeNew: false
      })
    ).deep.equals([])
    expect(m.counts().queries).equals(0)
  })
  it('reuses authority across many relevant rows and keeps spectators, API tokens, disabled actors and revoked rights private', async () => {
    for (let index = 0; index < 20; index++) await send('own-' + index)
    const m = measured()
    expect(
      await pendingSchedule(m.db, actor(101), f.clock.now(), {
        teamId: f.teamA
      })
    ).length(20)
    expect(m.counts().queries).at.most(16)
    for (const viewer of [
      undefined,
      actor(104),
      { ...actor(101), apiTokenId: 'fixture-read-token' }
    ]) {
      const rows = await pendingSchedule(f.h.db, viewer, f.clock.now(), {
        seasonIds: [f.seasonA]
      })
      expect(rows).length(20)
      expect(rows.every(row => row.pendingRequestId == null)).equals(true)
      expect(rows[0]).not.property('terms')
    }
    await f.h.db.deleteFrom('scope_roles').where('user_id', '=', 101).execute()
    const revoked = await pendingSchedule(f.h.db, actor(101), f.clock.now(), {
      teamId: f.teamA
    })
    expect(revoked.every(row => row.pendingRequestId == null)).equals(true)
    await f.h.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', 102)
      .execute()
    const disabled = await pendingSchedule(f.h.db, actor(102), f.clock.now(), {
      seasonIds: [f.seasonA]
    })
    expect(disabled.every(row => row.pendingRequestId == null)).equals(true)
    expect(
      await pendingSchedule(f.h.db, actor(106), f.clock.now())
    ).deep.equals([])
    expect(
      await pendingSchedule(f.h.db, actor(101), f.clock.now(), {
        seasonIds: []
      })
    ).deep.equals([])
  })
  it('annotates retained rows for their published teams but never projects a replacement for its removed opponent', async () => {
    const proposal = await send('published')
    const accepted = await f.h.request(
      'POST',
      `/game-requests/${proposal}/accept`,
      {},
      102
    )
    expect(accepted.status).equals(200)
    const gameId = (await accepted.json()).gameId
    const scheduling = await (
      await f.h.request('GET', `/games/${gameId}/scheduling`, undefined, 101)
    ).json()
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'query-b-admin',
        user_id: 101,
        scope_type: 'team',
        scope_id: f.teamB,
        role: 'admin'
      })
      .execute()
    const changed = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        gameId,
        expected: scheduling.version,
        game: { ...scheduling.game, awayTeamId: f.standaloneTeam },
        idempotencyKey: 'query-retained-change'
      },
      101
    )
    expect(changed.status).equals(201)
    const pending = await changed.json()
    const media = {
      space: f.h.space,
      mediaRoot: 'unused-test-media',
      mediaSecret: 'fixture-media',
      publicUrl: f.h.origin,
      ffmpegPath: 'unused'
    }
    const oldTeam = await scheduleOf(f.h.db, media, {
      actor: actor(102),
      teamId: f.teamB
    })
    expect(oldTeam).length(1)
    expect(oldTeam[0]).includes({
      id: gameId,
      pendingApproval: true,
      awayTeamId: f.teamB,
      pendingRequestId: null
    })
    expect(
      (
        await pendingSchedule(f.h.db, actor(103), f.clock.now(), {
          seasonIds: [f.seasonA]
        })
      )[0].pendingRequestId
    ).equals(pending.id)
    await f.h.db
      .updateTable('group_requests')
      .set({ status: 'declined' })
      .where('id', '=', pending.id)
      .execute()
    await f.h.db
      .deleteFrom('scope_roles')
      .where('id', '=', 'query-b-admin')
      .execute()
    const replacement = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.teamA },
        gameId,
        expected: scheduling.version,
        game: { ...scheduling.game, awayTeamId: f.standaloneTeam },
        idempotencyKey: 'query-distinct-change'
      },
      101
    )
    expect(replacement.status).equals(201)
    expect(
      (
        await publicGames(f.h.db, { kind: 'team', id: f.teamB }, actor(102))
      ).map(row => row.id)
    ).deep.equals([gameId])
    expect(
      (
        await publicGames(
          f.h.db,
          { kind: 'team', id: f.standaloneTeam },
          actor(103)
        )
      ).some(row => row.pendingApproval)
    ).equals(true)
    expect(
      await pendingSchedule(f.h.db, actor(102), f.clock.now(), {
        publishedGameIds: [gameId],
        includeNew: false
      })
    ).deep.equals([])
  })
  it('grants scoped request access through inherited custodians but rejects missing or placeholder team custodians', async () => {
    const response = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Season Placeholder',
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        },
        external: true,
        custodian: { kind: 'season', id: f.seasonA },
        idempotencyKey: 'query-season-placeholder'
      },
      101
    )
    expect(response.status).equals(201)
    const placeholder = (await response.json()).id
    const created = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        game: {
          homeTeamId: placeholder,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          status: 'scheduled'
        },
        idempotencyKey: 'query-custody-request'
      },
      101
    )
    expect(created.status).equals(201)
    const request = await created.json()
    expect(
      (
        await pendingSchedule(f.h.db, actor(102), f.clock.now(), {
          seasonIds: [f.seasonA]
        })
      )[0].pendingRequestId
    ).equals(request.id)
    const collection = await (
      await f.h.request('GET', `/seasons/${f.seasonA}/teams`, undefined, 101)
    ).json()
    // An unapproved proposal does not invent season membership.
    expect(collection.some((row: any) => row.id === placeholder)).equals(false)
    await f.h.db
      .insertInto('season_teams')
      .values([
        { season_id: f.seasonA, team_id: placeholder },
        { season_id: f.seasonA, team_id: f.teamB }
      ])
      .execute()
    const rows = await (
      await f.h.request('GET', `/seasons/${f.seasonA}/teams`, undefined, 101)
    ).json()
    expect(rows.find((row: any) => row.id === f.teamA).canViewPrivate).equals(
      true
    )
    expect(
      rows.find((row: any) => row.id === placeholder).canViewPrivate
    ).equals(false)
    expect(rows.find((row: any) => row.id === f.teamB).canViewPrivate).equals(
      false
    )
    const profile = await (
      await f.h.request('GET', `/teams/${placeholder}`, undefined, 101)
    ).json()
    expect(profile).includes({ canManage: true, canViewPrivate: false })
    // Keeping the placeholder is not being a member of it: what is kept for
    // members is refused.
    expect(
      (await f.h.request('GET', `/teams/${placeholder}/stats`, undefined, 101))
        .status
    ).equals(403)
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'query-legacy-placeholder-member',
        user_id: 101,
        team_id: placeholder,
        role: 'member'
      })
      .execute()
    const legacy = await (
      await f.h.request('GET', `/seasons/${f.seasonA}/teams`, undefined, 101)
    ).json()
    expect(
      legacy.find((row: any) => row.id === placeholder).canViewPrivate
    ).equals(true)
    expect(
      (await f.h.request('GET', `/teams/${placeholder}/games`, undefined, 101))
        .status
    ).equals(200)
  })
  it('keeps full-team custody checks cached and does not grant access through absent or placeholder custodians', async () => {
    const made = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Team Custody Placeholder',
        locality: {
          city: 'Demo City',
          region: 'Demo Region',
          country: 'US',
          placeId: null,
          timezone: 'UTC'
        },
        external: true,
        custodian: { kind: 'team', id: f.teamA },
        idempotencyKey: 'team-custody-placeholder'
      },
      101
    )
    expect(made.status).equals(201)
    const placeholder = (await made.json()).id
    const proposal = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: placeholder },
        game: {
          homeTeamId: placeholder,
          awayTeamId: f.standaloneTeam,
          seasonId: f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          status: 'scheduled'
        },
        idempotencyKey: 'team-custody-pending'
      },
      101
    )
    expect(proposal.status).equals(201)
    const id = (await proposal.json()).id
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'pending-team-curator',
        scope_type: 'team',
        scope_id: f.teamA,
        user_id: 106,
        role: 'admin'
      })
      .execute()
    const read = async (): Promise<string | null> =>
      (
        await pendingSchedule(f.h.db, actor(106), f.clock.now(), {
          teamId: placeholder
        })
      )[0].pendingRequestId
    expect(await read()).equals(id)
    await f.h.db
      .insertInto('teams')
      .values({
        id: 'pending-bad-team-custodian',
        name: 'Demo Placeholder Custodian',
        kind: 'external',
        custodian_type: 'team',
        custodian_id: f.teamA
      })
      .execute()
    for (const custodianId of [
      null,
      'missing-custodian-team',
      'pending-bad-team-custodian'
    ]) {
      await f.h.db
        .updateTable('teams')
        .set({
          custodian_id: custodianId,
          custodian_type: custodianId == null ? null : 'team'
        })
        .where('id', '=', placeholder)
        .execute()
      expect(await read()).equals(null)
    }
  })
})
