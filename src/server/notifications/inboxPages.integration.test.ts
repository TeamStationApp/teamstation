import { randomUUID } from 'node:crypto'
import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { hasPendingNotifications, inbox, notificationDetail } from './inbox'
import { InboxProjection } from './inboxProjection'
import * as wording from './requestInformation'

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
      expect(first.ms).lessThan(2000)
      const last = await read({
        history: true,
        cursor: `1|${new Date(f.clock.now().getTime() - 100000 + Math.max(0, count - 30)).toISOString()}|`
      })
      expect(last.queries).at.most(500)
      expect(last.ms).lessThan(2000)
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
      expect(result.ms).lessThan(2000)
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
      expect(result.ms).lessThan(2000)
      await read({ sent: true }, 101, 'cold')
      const sent = await read({ sent: true }, 101, 'warm')
      expect(sent.page).deep.equals({
        items: [],
        nextCursor: null,
        hasPending: true
      })
      expect(sent.queries).lessThan(800)
      expect(sent.ms).lessThan(2000)
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
      expect(first.ms).lessThan(2000)
      if (first.page.nextCursor != null) {
        const next = await read({
          history: true,
          cursor: first.page.nextCursor
        })
        expect(next.page.items).length(25)
        expect(next.queries).at.most(100)
        expect(next.ms).lessThan(2000)
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
})
