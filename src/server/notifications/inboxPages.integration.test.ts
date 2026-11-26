import { randomUUID } from 'node:crypto'
import { mock } from 'node:test'

import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { PlayerAddTerms } from '../../common/notifications'
import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import {
  mayAnswerPlayerAdd,
  rejoinedSince,
  supersededPlayerAdd
} from '../groups/noticePolicy'
import { hasPendingNotifications, inbox, notificationDetail } from './inbox'
import { InboxProjection } from './inboxProjection'
import * as wording from './requestInformation'

// Coverage adds work inside the measured call. The combined coverage command
// separately requires this entire suite without instrumentation and with the
// same 2 s budget. Ordinary test.integration always enforces that budget here.
const coverageTimings =
  process.env.TS_NOTIFICATION_COVERAGE_ONLY === '1' &&
  process.env.NODE_V8_COVERAGE != null
function withinLocalBudget(ms: number): void {
  if (!coverageTimings) expect(ms).lessThan(2000)
}

/** Scale is synthetic; each budget counts real PostgreSQL round trips. */
describe('bounded notification tab pages', function () {
  this.timeout(180000)
  let f: GroupFixture
  let maximumWindow = 0
  let classified = 0
  let worded = 0
  beforeEach(async () => {
    f = await groupFixture()
    // The wrapper invokes this captured method with .call(this, rows).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalRequests = InboxProjection.prototype.requests
    mock.method(
      InboxProjection.prototype,
      'requests',
      async function (
        this: InboxProjection,
        rows: Parameters<InboxProjection['requests']>[0]
      ) {
        maximumWindow = Math.max(maximumWindow, rows.length)
        classified += rows.length
        return await originalRequests.call(this, rows)
      }
    )
    const originalWords = wording.titleAndDescription
    mock.method(
      wording,
      'titleAndDescription',
      async (...args: Parameters<typeof wording.titleAndDescription>) => {
        worded++
        return await originalWords(...args)
      }
    )
  })
  afterEach(async () => {
    mock.restoreAll()
    await f?.h.close()
  })
  async function requests(
    count: number,
    status: 'pending' | 'accepted',
    hidden = false,
    distinct = false
  ): Promise<string[]> {
    const ids: string[] = []
    for (let at = 0; at < count; at += 100) {
      const batch = Array.from(
        { length: Math.min(100, count - at) },
        (_, i) => ({
          id: randomUUID(),
          kind: 'membership' as const,
          sender_id: userIdOfGumbo(102),
          sender_scope_type: 'season' as const,
          sender_scope_id: f.seasonB,
          terms: JSON.stringify({
            kind: 'membership',
            teamId: f.teamA,
            userId: userIdOfGumbo(102)
          }),
          status,
          sent_at: new Date(f.clock.now().getTime() - 100000 + at + i),
          expires_at: new Date(f.clock.now().getTime() + 86400000)
        })
      )
      await f.h.db.insertInto('group_requests').values(batch).execute()
      await f.h.db
        .insertInto('group_request_sides')
        .values(
          batch.map(r => ({
            request_id: r.id,
            scope_type: 'team' as const,
            scope_id: hidden
              ? distinct
                ? randomUUID()
                : f.standaloneTeam
              : f.teamA
          }))
        )
        .execute()
      if (hidden)
        await f.h.db
          .insertInto('notification_events')
          .values(
            batch.map(r => ({
              id: randomUUID(),
              source_type: 'groupRequest',
              source_id: r.id,
              revision: 1,
              metadata: '{}',
              recorded_recipients: [userIdOfGumbo(101)],
              created_at: r.sent_at
            }))
          )
          .execute()
      ids.push(...batch.map(r => r.id))
    }
    return ids
  }
  async function notices(count: number): Promise<string[]> {
    const ids: string[] = []
    for (let at = 0; at < count; at += 100) {
      const batch = Array.from(
        { length: Math.min(100, count - at) },
        (_, i) => ({
          id: randomUUID(),
          source_type: 'scheduleChanged',
          source_id: randomUUID(),
          revision: 1,
          metadata: JSON.stringify({
            title: 'Synthetic historical notice',
            description: 'Recorded history'
          }),
          recorded_recipients: [userIdOfGumbo(101)],
          created_at: new Date(f.clock.now().getTime() - 100000 + at + i)
        })
      )
      await f.h.db.insertInto('notification_events').values(batch).execute()
      ids.push(...batch.map(r => r.id))
    }
    return ids
  }
  function measured() {
    let queries = 0
    let roleReads = 0
    const db = f.h.db.withPlugin({
      transformQuery: args => {
        queries++
        if (JSON.stringify(args.node).includes('"name":"scope_roles"'))
          roleReads++
        return args.node
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    return async (
      options: Parameters<typeof inbox>[2],
      person = 101,
      phase = 'single'
    ) => {
      queries = 0
      roleReads = 0
      maximumWindow = 0
      classified = 0
      worded = 0
      const start = performance.now()
      const page = await inbox(db, actor(person), options, f.clock)
      const result = {
        page,
        queries,
        roleReads,
        classified,
        maximumWindow,
        worded,
        ms: performance.now() - start
      }
      expect(maximumWindow).at.most(100)
      expect(worded).at.most(options?.limit ?? 25)
      expect(roleReads).at.most(10)
      console.log(
        JSON.stringify({
          case: 'tab-page',
          instrumented: coverageTimings,
          phase,
          options,
          person,
          queries,
          roleReads,
          classified,
          maximumWindow,
          worded,
          ms: Math.round(result.ms),
          items: page.items.length
        })
      )
      return result
    }
  }
  it('keeps first and late History pages bounded through10000 requests, with Sent/Pending independent of resolved rows', async () => {
    await requests(1, 'pending')
    const read = measured()
    const budgets: number[][] = []
    const all: string[] = []
    for (const count of [0, 100, 900, 9000]) {
      all.push(...(await requests(count, 'accepted')))
      const pending = await read({})
      const sent = await read({ sent: true }, 102)
      expect(pending.page.items).length(1)
      expect(sent.page.items).length(1)
      budgets.push([pending.queries, sent.queries])
      if (all.length === 0) continue
      const first = await read({ history: true })
      expect(first.page.items).length(25)
      expect(first.page.hasPending).equals(true)
      expect(first.queries).at.most(500)
      withinLocalBudget(first.ms)
      const last = await read({
        history: true,
        cursor: `1|${new Date(f.clock.now().getTime() - 100000 + Math.max(0, count - 30)).toISOString()}|`
      })
      expect(last.queries).at.most(500)
      withinLocalBudget(last.ms)
      const http = await f.h.request(
        'GET',
        '/me/notifications?history=1',
        undefined,
        101
      )
      expect(http.status).equals(200)
      expect(await http.json()).deep.equals(first.page)
      expect(
        await notificationDetail(
          f.h.db,
          actor(101),
          first.page.items[0].requestId,
          f.clock
        )
      ).deep.equals(first.page.items[0])
    }
    expect(budgets).deep.equals(budgets.map(() => budgets[0]))
    const past = await read({
      history: true,
      cursor: '1|2999-01-01T00:00:00.000Z|z'
    })
    expect(past.page).deep.equals({
      items: [],
      nextCursor: null,
      hasPending: true
    })
    expect(
      (await hasPendingNotifications(f.h.db, actor(101), f.clock)).hasPending
    ).equals(true)
  })
  it('merges and traverses every row of10000 mixed historical items exactly once', async () => {
    const requestIds = await requests(5000, 'accepted')
    const eventIds = await notices(5000)
    const expected = new Set([...requestIds, ...eventIds])
    const seen: string[] = []
    let cursor: string | null = null
    const read = measured()
    do {
      const result = await read({
        history: true,
        limit: 100,
        ...(cursor == null ? {} : { cursor })
      })
      expect(result.queries).at.most(500)
      withinLocalBudget(result.ms)
      seen.push(...result.page.items.map(r => r.requestId))
      cursor = result.page.nextCursor
    } while (cursor != null)
    console.log(
      JSON.stringify({
        traversalSeen: seen.length,
        requests: seen.filter(id => requestIds.includes(id)).length,
        events: seen.filter(id => eventIds.includes(id)).length
      })
    )
    expect(seen).length(10000)
    expect(new Set(seen)).deep.equals(expected)
    expect((await read({})).page.hasPending).equals(false)
  })
  for (const distinct of [false, true])
    it(`passes10000 inaccessible active candidates in batches (${distinct ? 'distinct' : 'repeated'} scopes)`, async () => {
      await requests(10000, 'pending', true, distinct)
      const visible = await requests(1, 'pending')
      // Move the authorized request behind the whole rejected prefix.
      await f.h.db
        .updateTable('group_requests')
        .set({ sent_at: f.clock.now() })
        .where('id', '=', visible[0])
        .execute()
      const read = measured()
      await read({}, 101, 'cold')
      const result = await read({}, 101, 'warm')
      expect(result.page.items.map(r => r.requestId)).deep.equals(visible)
      expect(result.page.nextCursor).equals(null)
      expect(result.page.hasPending).equals(true)
      expect(result.queries).lessThan(1600)
      withinLocalBudget(result.ms)
      await read({ sent: true }, 101, 'cold')
      const sent = await read({ sent: true }, 101, 'warm')
      expect(sent.page).deep.equals({
        items: [],
        nextCursor: null,
        hasPending: true
      })
      expect(sent.queries).lessThan(800)
      withinLocalBudget(sent.ms)
    })
  it('keeps information-only first/late pages and empty Sent reads bounded through10000 events', async () => {
    const read = measured()
    let total = 0
    const budgets: number[] = []
    for (const extra of [0, 100, 900, 9000]) {
      await notices(extra)
      total += extra
      const first = await read({ history: true })
      expect(first.page.items).length(Math.min(25, total))
      expect(first.queries).at.most(100)
      withinLocalBudget(first.ms)
      if (first.page.nextCursor != null) {
        const next = await read({
          history: true,
          cursor: first.page.nextCursor
        })
        expect(next.page.items).length(25)
        expect(next.queries).at.most(100)
        withinLocalBudget(next.ms)
        expect(
          new Set([...first.page.items, ...next.page.items].map(r => r.id)).size
        ).equals(50)
      }
      const sent = await read({ sent: true })
      budgets.push(sent.queries)
      expect(sent.page).deep.equals({
        items: [],
        nextCursor: null,
        hasPending: false
      })
    }
    expect(budgets).deep.equals(budgets.map(() => budgets[0]))
  })
  it('releases server cursors before returning a page inside an existing transaction', async () => {
    await requests(150, 'accepted')
    await f.h.db.transaction().execute(async db => {
      const first = await inbox(db, actor(101), { history: true }, f.clock)
      expect(first.items).length(25)
      expect(first.nextCursor).not.equals(null)
      const cursors = await sql<{
        name: string
      }>`select name from pg_cursors where name like 'notification_page_%'`.execute(
        db
      )
      expect(cursors.rows).deep.equals([])
      const second = await inbox(
        db,
        actor(101),
        { history: true, cursor: first.nextCursor! },
        f.clock
      )
      expect(second.items).length(25)
      expect(
        new Set([...first.items, ...second.items].map(row => row.id)).size
      ).equals(50)
    })
  })
  it('preserves millisecond ties and legacy cursor spelling across pages', async () => {
    const ids = (await requests(3, 'accepted')).sort()
    const time = new Date(Math.floor(f.clock.now().getTime() / 1000) * 1000)
    for (let i = 0; i < ids.length; i++)
      await f.h.db
        .updateTable('group_requests')
        .set({
          sent_at: sql<Date>`${time.toISOString()}::timestamptz + ${(3 - i) * 200} * interval '1 microsecond'`
        })
        .where('id', '=', ids[i])
        .execute()
    let cursor: string | null = null
    const seen: string[] = []
    do {
      const page = await inbox(
        f.h.db,
        actor(101),
        { history: true, limit: 1, ...(cursor == null ? {} : { cursor }) },
        f.clock
      )
      seen.push(...page.items.map(row => row.requestId))
      cursor = page.nextCursor
    } while (cursor != null)
    expect(seen).deep.equals(ids)
    // The original comparison is textual: omitting milliseconds sorts after
    // these canonical keys even though it describes the same instant.
    const alternate = time.toISOString().replace('.000Z', 'Z')
    const legacy = await inbox(
      f.h.db,
      actor(101),
      { history: true, cursor: `${alternate}|${ids[0]}` },
      f.clock
    )
    expect(legacy.items).deep.equals([])
  })
  it('matches live player-add authority across player, guardian and sender merges and held teams', async () => {
    const template = await f.h.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userIdOfGumbo(103))
      .executeTakeFirstOrThrow()
    const player = userIdOfGumbo(300001)
    const guardian = userIdOfGumbo(300002)
    const sender = userIdOfGumbo(300003)
    await f.h.db
      .insertInto('users')
      .values(
        [
          [player, userIdOfGumbo(103)],
          [guardian, userIdOfGumbo(101)],
          [sender, userIdOfGumbo(102)]
        ].map(([id, mergedInto]) => ({
          ...template,
          id,
          merged_into: mergedInto,
          legacyId: null,
          username: null
        }))
      )
      .execute()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: randomUUID(),
        user_id: guardian,
        related_user_id: player,
        kind: 'guardian',
        created_at: f.clock.now()
      })
      .execute()
    const request = await f.h.db
      .insertInto('group_requests')
      .values({
        id: randomUUID(),
        kind: 'playerAdd',
        sender_id: sender,
        sender_scope_type: 'team',
        sender_scope_id: f.teamB,
        terms: JSON.stringify({
          kind: 'playerAdd',
          userId: player,
          teamId: f.teamB,
          mode: 'roster'
        }),
        status: 'pending',
        sent_at: f.clock.now(),
        expires_at: new Date(f.clock.now().getTime() + 86400000)
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const check = async (expected: boolean, reader = 101): Promise<void> => {
      expect(await mayAnswerPlayerAdd(f.h.db, actor(reader), request)).equals(
        expected
      )
      const states = await new InboxProjection(
        f.h.db,
        actor(reader),
        f.clock
      ).requests([request])
      expect(states.get(request.id)?.canAct ?? false).equals(expected)
    }
    await check(true)
    await f.h.db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(101) })
      .where('id', '=', sender)
      .execute()
    await check(false)
    await f.h.db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(102) })
      .where('id', '=', sender)
      .execute()
    await f.h.db
      .deleteFrom('user_links')
      .where('user_id', '=', guardian)
      .execute()
    await check(false)
    await f.h.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', userIdOfGumbo(103))
      .execute()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: randomUUID(),
        user_id: player,
        team_id: f.teamA,
        role: 'member',
        is_player: true
      })
      .execute()
    await check(true)
    const hold = await f.h.db
      .insertInto('group_requests')
      .values({
        id: randomUUID(),
        kind: 'playerAdd',
        sender_id: userIdOfGumbo(101),
        sender_scope_type: 'team',
        sender_scope_id: f.teamA,
        initiating_team_id: f.teamA,
        terms: JSON.stringify({
          kind: 'playerAdd',
          userId: player,
          teamId: f.teamA,
          mode: 'roster'
        }),
        status: 'applied',
        sent_at: f.clock.now(),
        expires_at: new Date(f.clock.now().getTime() + 86400000)
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await check(false)
    await f.h.db
      .updateTable('group_requests')
      .set({ status: 'accepted' })
      .where('id', '=', hold.id)
      .execute()
    await check(true)
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: randomUUID(),
        user_id: userIdOfGumbo(106),
        scope_type: 'season',
        scope_id: f.seasonA,
        role: 'admin',
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    await check(true, 106)
    await f.h.db
      .updateTable('system_settings')
      .set({ value: false })
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    await check(false, 106)
    await check(true)
    await f.h.db
      .updateTable('system_settings')
      .set({ value: true })
      .where('key', '=', 'creation.hierarchyReady')
      .execute()
    await check(true, 106)
  })
  it('matches rejection policy across merged aliases, rejoining, pool games and exact deadlines', async () => {
    const player = userIdOfGumbo(103)
    const alias = userIdOfGumbo(399999)
    const template = await f.h.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', player)
      .executeTakeFirstOrThrow()
    await f.h.db
      .insertInto('users')
      .values({
        ...template,
        id: alias,
        legacyId: null,
        username: null,
        merged_into: player
      })
      .execute()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: randomUUID(),
        user_id: userIdOfGumbo(101),
        related_user_id: alias,
        kind: 'guardian',
        created_at: f.clock.now()
      })
      .execute()
    for (const variant of [
      'sameTime',
      'later',
      'accepted',
      'pending',
      'otherTeam',
      'otherMode',
      'otherGame',
      'sameGame',
      'rejoined',
      'ownMembership',
      'expired'
    ] as const) {
      const member = randomUUID()
      const pool = variant === 'sameGame' || variant === 'otherGame'
      const terms = {
        kind: 'playerAdd' as const,
        userId: alias,
        teamId: f.teamB,
        mode: pool ? ('pool' as const) : ('roster' as const),
        gameId: pool ? 'game-one' : undefined,
        membershipId: pool ? undefined : member
      }
      const row = await f.h.db
        .insertInto('group_requests')
        .values({
          id: randomUUID(),
          kind: 'playerAdd',
          sender_id: userIdOfGumbo(102),
          sender_scope_type: 'team',
          sender_scope_id: f.teamB,
          terms: JSON.stringify(terms),
          status: 'applied',
          sent_at: new Date(f.clock.now().getTime() - 10000),
          expires_at: new Date(
            f.clock.now().getTime() + (variant === 'expired' ? 0 : 86400000)
          )
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      if (variant === 'rejoined' || variant === 'ownMembership')
        await f.h.db
          .insertInto('memberships')
          .values({
            id: variant === 'rejoined' ? randomUUID() : member,
            user_id: player,
            team_id: f.teamB,
            role: 'member',
            is_player: true
          })
          .execute()
      else if (variant !== 'expired')
        await f.h.db
          .insertInto('group_requests')
          .values({
            id: randomUUID(),
            kind: 'playerAdd',
            sender_id: userIdOfGumbo(102),
            sender_scope_type: 'team',
            sender_scope_id: f.teamB,
            terms: JSON.stringify({
              ...terms,
              userId: player,
              teamId: variant === 'otherTeam' ? f.teamA : f.teamB,
              mode: variant === 'otherMode' ? 'pool' : terms.mode,
              gameId: variant === 'otherGame' ? 'game-two' : terms.gameId
            }),
            status:
              variant === 'pending'
                ? 'pending'
                : variant === 'accepted'
                  ? 'accepted'
                  : 'applied',
            sent_at: new Date(
              row.sent_at.getTime() + (variant === 'sameTime' ? 0 : 1)
            ),
            expires_at: row.expires_at
          })
          .execute()
      const expected =
        variant !== 'expired' &&
        !(await supersededPlayerAdd(f.h.db, row)) &&
        !(await rejoinedSince(f.h.db, row.terms as PlayerAddTerms))
      const state = (
        await new InboxProjection(f.h.db, actor(101), f.clock).requests([row])
      ).get(row.id)
      expect(state?.canReject, variant).equals(expected)
      expect(expected, variant).equals(
        !['later', 'accepted', 'sameGame', 'rejoined', 'expired'].includes(
          variant
        )
      )
      await f.h.db
        .deleteFrom('group_requests')
        .where('kind', '=', 'playerAdd')
        .execute()
      await f.h.db
        .deleteFrom('memberships')
        .where('user_id', '=', player)
        .where('team_id', '=', f.teamB)
        .execute()
    }
  })
  for (const count of [1000, 10000])
    for (const variant of ['applied', 'email', 'guardian'] as const)
      it(`batches ${count} distinct ${variant} candidates excluded from the tab`, async () => {
        const template = await f.h.db
          .selectFrom('users')
          .selectAll()
          .where('id', '=', userIdOfGumbo(103))
          .executeTakeFirstOrThrow()
        const ids: string[] = []
        for (let at = 0; at < count; at += 100) {
          const players = Array.from({ length: 100 }, (_, i) =>
            userIdOfGumbo(300000 + at + i)
          )
          const memberships = players.map(() => randomUUID())
          if (variant !== 'email') {
            await f.h.db
              .insertInto('users')
              .values(
                players.map(id => ({
                  ...template,
                  id,
                  legacyId: null,
                  username: null
                }))
              )
              .execute()
            await f.h.db
              .insertInto('user_links')
              .values(
                players.map(id => ({
                  id: randomUUID(),
                  user_id: userIdOfGumbo(variant === 'applied' ? 101 : 104),
                  related_user_id: id,
                  kind: 'guardian' as const,
                  created_at: f.clock.now()
                }))
              )
              .execute()
            await f.h.db
              .insertInto('memberships')
              .values(
                players.map((id, i) => ({
                  id: memberships[i],
                  user_id: id,
                  team_id: f.teamB,
                  role: 'member' as const,
                  is_player: true
                }))
              )
              .execute()
          }
          const rows = players.map((id, i) => ({
            id: randomUUID(),
            kind:
              variant === 'applied'
                ? ('playerAdd' as const)
                : variant === 'guardian'
                  ? ('guardian' as const)
                  : ('person' as const),
            sender_id: userIdOfGumbo(102),
            sender_scope_type: 'team' as const,
            sender_scope_id: f.teamB,
            terms: JSON.stringify(
              variant === 'applied'
                ? {
                    kind: 'playerAdd',
                    userId: id,
                    teamId: f.teamB,
                    mode: 'roster',
                    membershipId: memberships[i]
                  }
                : variant === 'guardian'
                  ? {
                      kind: 'guardian',
                      playerUserId: id,
                      guardian: { userId: userIdOfGumbo(102) }
                    }
                  : {
                      kind: 'person',
                      scope: { kind: 'team', id: f.teamB },
                      recipientEmail: `${id}@example.test`,
                      recipientUserId: null,
                      admin: false,
                      flags: []
                    }
            ),
            status:
              variant === 'applied'
                ? ('applied' as const)
                : ('pending' as const),
            sent_at: new Date(f.clock.now().getTime() - 200000 - at - i),
            expires_at: new Date(f.clock.now().getTime() + 86400000)
          }))
          await f.h.db.insertInto('group_requests').values(rows).execute()
          if (variant !== 'applied')
            await f.h.db
              .insertInto('group_request_sides')
              .values(
                rows.map((row, i) => ({
                  request_id: row.id,
                  scope_type: 'user' as const,
                  scope_id:
                    variant === 'email'
                      ? `email:${players[i]}@example.test`
                      : players[i]
                }))
              )
              .execute()
          await f.h.db
            .insertInto('notification_events')
            .values(
              rows.map(row => ({
                id: randomUUID(),
                source_type: 'groupRequest',
                source_id: row.id,
                revision: 1,
                metadata: '{}',
                recorded_recipients: [userIdOfGumbo(101)],
                created_at: row.sent_at
              }))
            )
            .execute()
          ids.push(...rows.map(r => r.id))
        }
        const read = measured()
        const options =
          variant === 'applied' ? { history: true } : { sent: true }
        await read(options, 101, 'cold')
        const result = await read(options, 101, 'warm')
        expect(result.page).deep.equals({
          items: [],
          nextCursor: null,
          hasPending: variant === 'applied'
        })
        expect(result.queries).lessThan((12 * count) / 100 + 100)
        expect(result.worded).equals(0)
        expect(result.maximumWindow).at.most(100)
        withinLocalBudget(result.ms)
        // A dismissed notice behind the entire rejectable prefix remains in
        // History, and independently witnessed Pending remains true.
        if (variant === 'applied') {
          const event = await f.h.db
            .selectFrom('notification_events')
            .select('id')
            .where('source_id', '=', ids[count - 1])
            .executeTakeFirstOrThrow()
          await f.h.db
            .insertInto('notification_receipts')
            .values({
              event_id: event.id,
              user_id: userIdOfGumbo(101),
              viewed_at: f.clock.now(),
              dismissed_at: f.clock.now()
            })
            .execute()
          const page = await inbox(
            f.h.db,
            actor(101),
            { history: true },
            f.clock
          )
          expect(page.items.map(row => row.requestId)).deep.equals([
            ids[count - 1]
          ])
          expect(page.items[0].canReject).equals(true)
          expect(page.hasPending).equals(true)
          expect(page.nextCursor).equals(null)
        } else if (variant === 'guardian') {
          await f.h.db
            .insertInto('user_links')
            .values({
              id: randomUUID(),
              user_id: userIdOfGumbo(101),
              related_user_id: userIdOfGumbo(300000 + count - 1),
              kind: 'guardian',
              created_at: f.clock.now()
            })
            .execute()
          const page = await inbox(f.h.db, actor(101), undefined, f.clock)
          expect(
            page.items.find(row => row.requestId === ids[count - 1])?.canAct
          ).equals(true)
        } else {
          const email = `${userIdOfGumbo(300000 + count - 1)}@example.test`
          await f.h.db
            .insertInto('user_emails')
            .values({
              id: randomUUID(),
              user_id: userIdOfGumbo(101),
              email: email.toUpperCase(),
              verified_at: null
            })
            .execute()
          expect(
            (await hasPendingNotifications(f.h.db, actor(101), f.clock))
              .hasPending
          ).equals(false)
          await f.h.db
            .updateTable('user_emails')
            .set({ verified_at: f.clock.now() })
            .where('user_id', '=', userIdOfGumbo(101))
            .where('email', '=', email.toUpperCase())
            .execute()
          const page = await inbox(f.h.db, actor(101), undefined, f.clock)
          expect(
            page.items.find(row => row.requestId === ids[count - 1])?.canAct
          ).equals(true)
        }
      })
  for (const variant of [
    'guardian',
    'self',
    'standIn',
    'held',
    'inheritedCoach'
  ] as const)
    for (const count of [1000, 10000])
      it(`batches ${count} distinct inaccessible player adds (${variant})`, async () => {
        const reader = ['held', 'inheritedCoach'].includes(variant) ? 106 : 101
        if (variant === 'held' || variant === 'inheritedCoach')
          await f.h.db
            .insertInto('scope_roles')
            .values({
              id: randomUUID(),
              user_id: userIdOfGumbo(reader),
              scope_type: variant === 'held' ? 'team' : 'season',
              scope_id: variant === 'held' ? f.teamA : f.seasonA,
              role: 'coach',
              granted_by: userIdOfGumbo(101)
            })
            .execute()
        const template = await f.h.db
          .selectFrom('users')
          .selectAll()
          .where('id', '=', userIdOfGumbo(103))
          .executeTakeFirstOrThrow()
        const ids: string[] = []
        for (let at = 0; at < count; at += 100) {
          const players = Array.from({ length: 100 }, (_, i) =>
            userIdOfGumbo(200000 + at + i)
          )
          await f.h.db
            .insertInto('users')
            .values(
              players.map(id => ({
                ...template,
                id,
                legacyId: null,
                username: null,
                login_enabled: variant === 'self'
              }))
            )
            .execute()
          // The reader's team used to stand in. A signing-in guardian now has
          // the say, while the original recipients still select every request.
          await f.h.db
            .insertInto('memberships')
            .values(
              players.map(id => ({
                id: randomUUID(),
                user_id: id,
                team_id: variant === 'standIn' ? f.standaloneTeam : f.teamA,
                role: 'member' as const,
                is_player: true
              }))
            )
            .execute()
          if (variant === 'guardian')
            await f.h.db
              .insertInto('user_links')
              .values(
                players.map(id => ({
                  id: randomUUID(),
                  user_id: userIdOfGumbo(104),
                  related_user_id: id,
                  kind: 'guardian' as const,
                  created_at: f.clock.now()
                }))
              )
              .execute()
          const rows = players.map((id, i) => ({
            id: randomUUID(),
            kind: 'playerAdd' as const,
            sender_id: userIdOfGumbo(102),
            sender_scope_type: 'team' as const,
            sender_scope_id: f.teamB,
            terms: JSON.stringify({
              kind: 'playerAdd',
              userId: id,
              teamId: f.teamB,
              mode: 'roster'
            }),
            status: 'pending' as const,
            sent_at: new Date(f.clock.now().getTime() - 200000 - at - i),
            expires_at: new Date(f.clock.now().getTime() + 86400000)
          }))
          await f.h.db.insertInto('group_requests').values(rows).execute()
          if (variant === 'held')
            await f.h.db
              .insertInto('group_requests')
              .values(
                players.map(id => ({
                  id: randomUUID(),
                  kind: 'playerAdd' as const,
                  sender_id: userIdOfGumbo(101),
                  sender_scope_type: 'team' as const,
                  sender_scope_id: f.teamA,
                  initiating_team_id: f.teamA,
                  terms: JSON.stringify({
                    kind: 'playerAdd',
                    userId: id,
                    teamId: f.teamA,
                    mode: 'roster'
                  }),
                  status: 'applied' as const,
                  sent_at: new Date(f.clock.now().getTime() - 300000),
                  expires_at: new Date(f.clock.now().getTime() + 86400000)
                }))
              )
              .execute()

          await f.h.db
            .insertInto('notification_events')
            .values(
              rows.map(row => ({
                id: randomUUID(),
                source_type: 'groupRequest',
                source_id: row.id,
                revision: 1,
                metadata: '{}',
                recorded_recipients: [userIdOfGumbo(reader)],
                created_at: row.sent_at
              }))
            )
            .execute()
          ids.push(...rows.map(row => row.id))
        }
        const read = measured()
        for (const options of [{ sent: true }, { history: true }]) {
          await read(options, reader, 'cold')
          const result = await read(options, reader, 'warm')
          expect(result.page).deep.equals({
            items: [],
            nextCursor: null,
            hasPending: false
          })
          // At most 16 reads per 100-row window plus read setup, never per-player
          // identity/guardian queries. History must independently scan Pending.
          expect(result.queries).lessThan((16 * count) / 100 + 100)
          expect(result.classified).equals(
            variant === 'held'
              ? 3 * count
              : 'sent' in options
                ? 2 * count
                : count
          )
          withinLocalBudget(result.ms)
        }
        if (variant === 'held') return
        // An accessible request at the very end must still be found by Pending
        // existence on an empty History page, without trusting recorded access.
        await f.h.db
          .deleteFrom('user_links')
          .where('related_user_id', '=', userIdOfGumbo(200000 + count - 1))
          .execute()
        await f.h.db
          .insertInto('user_links')
          .values({
            id: randomUUID(),
            user_id: userIdOfGumbo(reader),
            related_user_id: userIdOfGumbo(200000 + count - 1),
            kind: 'guardian',
            created_at: f.clock.now()
          })
          .execute()
        const history = await inbox(
          f.h.db,
          actor(reader),
          { history: true },
          f.clock
        )
        expect(history).deep.equals({
          items: [],
          nextCursor: null,
          hasPending: true
        })
        const pending = await inbox(f.h.db, actor(reader), undefined, f.clock)
        expect(pending.items.map(row => row.requestId)).deep.equals([
          ids[count - 1]
        ])
        expect(pending.items[0].canAct).equals(true)
        if (variant !== 'guardian') return
        // With the guardian removed the original stand-in rule applies again.
        await f.h.db
          .deleteFrom('user_links')
          .where('related_user_id', '=', userIdOfGumbo(200000 + count - 1))
          .execute()
        const standIn = await inbox(f.h.db, actor(reader), undefined, f.clock)
        expect(standIn.items.map(row => row.requestId)).deep.equals([
          ids[count - 1]
        ])
        expect(standIn.items[0].canAct).equals(true)
      })
  for (const count of [1000, 10000])
    it(`batches History eligibility for ${count} distinct guarded players and sees guardian revocation`, async () => {
      const template = await f.h.db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', userIdOfGumbo(103))
        .executeTakeFirstOrThrow()
      for (let at = 0; at < count; at += 100) {
        const players = Array.from({ length: 100 }, (_, i) =>
          userIdOfGumbo(100000 + at + i)
        )
        await f.h.db
          .insertInto('users')
          .values(
            players.map(id => ({
              ...template,
              id,
              legacyId: null,
              username: null
            }))
          )
          .execute()
        await f.h.db
          .insertInto('user_links')
          .values(
            players.map(id => ({
              id: randomUUID(),
              user_id: userIdOfGumbo(104),
              related_user_id: id,
              kind: 'guardian' as const,
              created_at: f.clock.now()
            }))
          )
          .execute()
        const rows = players.map(id => ({
          id: randomUUID(),
          kind: 'guardian' as const,
          sender_id: userIdOfGumbo(102),
          sender_scope_type: null,
          sender_scope_id: null,
          terms: JSON.stringify({
            kind: 'guardian',
            playerUserId: id,
            guardian: { userId: userIdOfGumbo(104) }
          }),
          status: 'accepted' as const,
          sent_at: new Date(f.clock.now().getTime() - 200000),
          expires_at: f.clock.now()
        }))
        await f.h.db.insertInto('group_requests').values(rows).execute()
        await f.h.db
          .insertInto('group_request_sides')
          .values(
            rows.map(row => ({
              request_id: row.id,
              scope_type: 'team' as const,
              scope_id: f.teamA
            }))
          )
          .execute()
      }
      const visible = await requests(1, 'accepted')
      const read = measured()
      await read({ history: true }, 101, 'cold')
      const result = await read({ history: true }, 101, 'warm')
      expect(result.page.items.map(row => row.requestId)).deep.equals(visible)
      expect(result.page).include({ nextCursor: null, hasPending: false })
      expect(result.queries).lessThan(1300)
      withinLocalBudget(result.ms)
      await f.h.db
        .updateTable('users')
        .set({ disabled_at: f.clock.now() })
        .where('id', '=', userIdOfGumbo(104))
        .execute()
      const changed = await inbox(
        f.h.db,
        actor(101),
        { history: true, limit: 1 },
        f.clock
      )
      expect(changed.items[0].type).equals('guardian')
      expect(changed.items[0].requestId).not.equals(visible[0])
      expect(changed.nextCursor).not.equals(null)
    })
})
