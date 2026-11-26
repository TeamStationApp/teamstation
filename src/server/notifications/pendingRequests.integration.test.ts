import { randomUUID } from 'node:crypto'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  type Notification,
  RECORDING_UPLOAD,
  UMPIRE_MISSING_SLOTS
} from '../../common/notifications'
import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { recordPlayerAdd } from '../groups/noticePolicy'
import { hasPendingNotifications, inbox } from './inbox'
import { PLAYER_ADD_REJECTED } from './pending'

interface Page {
  items: Notification[]
  hasPending: boolean
  nextCursor: string | null
}

describe('pending reads skip resolved request history', function () {
  this.timeout(120000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  async function send(): Promise<string> {
    const response = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'participation',
        teamId: f.teamA,
        seasonId: f.seasonB,
        sender: { kind: 'season', id: f.seasonB },
        idempotencyKey: randomUUID()
      },
      102
    )
    expect(response.status).equals(201)
    return ((await response.json()) as { id: string }).id
  }
  async function page(query = '', person = 101): Promise<Page> {
    const response = await f.h.request(
      'GET',
      `/me/notifications${query}`,
      undefined,
      person
    )
    expect(response.status).equals(200)
    return (await response.json()) as Page
  }
  async function notice(type: string): Promise<string> {
    const id = randomUUID()
    await f.h.db
      .insertInto('notification_events')
      .values({
        id,
        source_type: type,
        source_id: id,
        revision: 1,
        actor_id: null,
        metadata: JSON.stringify({
          title: 'Synthetic notice',
          description: 'Fixture reminder',
          userId: userIdOfGumbo(106)
        }),
        recorded_recipients: [userIdOfGumbo(101)],
        created_at: f.clock.now()
      })
      .execute()
    return id
  }
  async function copies(
    templateId: string,
    count: number,
    resolved: boolean
  ): Promise<string[]> {
    const template = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', templateId)
      .executeTakeFirstOrThrow()
    const sides = await f.h.db
      .selectFrom('group_request_sides')
      .selectAll()
      .where('request_id', '=', templateId)
      .execute()
    const rows = Array.from({ length: count }, (_, i) => ({
      ...template,
      id: randomUUID(),
      sent_at: new Date(f.clock.now().getTime() - 1000),
      status: resolved
        ? (['accepted', 'declined', 'cancelled', 'pending'] as const)[i % 4]
        : ('pending' as const),
      expires_at: resolved && i % 4 === 3 ? f.clock.now() : template.expires_at
    }))
    for (let at = 0; at < rows.length; at += 100) {
      const batch = rows.slice(at, at + 100)
      await f.h.db.insertInto('group_requests').values(batch).execute()
      await f.h.db
        .insertInto('group_request_sides')
        .values(
          batch.flatMap(row =>
            sides.map(side => ({ ...side, request_id: row.id }))
          )
        )
        .execute()
    }
    return rows.map(row => row.id)
  }

  it('keeps both reads at a fixed query budget at 0, 100 and 1000 resolved rows, with exact HTTP responses', async () => {
    const id = await send()
    let count = 0
    const watched = f.h.db.withPlugin({
      transformQuery: args => {
        count++
        return args.node
      },
      transformResult: async args => await Promise.resolve(args.result)
    })
    const budgets: number[][] = []
    const expected = await page()
    expect(expected.items.map(row => row.requestId)).deep.equals([id])
    for (const extra of [0, 100, 900]) {
      if (extra > 0) await copies(id, extra, true)
      count = 0
      const start = performance.now()
      expect(await inbox(watched, actor(101), {}, f.clock)).deep.equals(
        expected
      )
      const pending = count
      count = 0
      expect(
        (await hasPendingNotifications(watched, actor(101), f.clock)).hasPending
      ).equals(true)
      budgets.push([pending, count])
      expect(await page()).deep.equals(expected)
      console.log(
        JSON.stringify({
          case: 'fixed-active',
          resolved:
            budgets.length === 1 ? 0 : budgets.length === 2 ? 100 : 1000,
          queries: budgets.at(-1),
          ms: Math.round(performance.now() - start)
        })
      )
    }
    expect(budgets).deep.equals([budgets[0], budgets[0], budgets[0]])
    await f.h.db
      .updateTable('group_requests')
      .set({ status: 'accepted' })
      .where('id', '=', id)
      .execute()
    expect(await page()).deep.equals({
      items: [],
      nextCursor: null,
      hasPending: false
    })
    expect(
      (await hasPendingNotifications(watched, actor(101), f.clock)).hasPending
    ).equals(false)
    const ids = await Promise.all(
      [RECORDING_UPLOAD, PLAYER_ADD_REJECTED, UMPIRE_MISSING_SLOTS].map(notice)
    )
    const notices = await page()
    expect(notices.items.map(row => row.id).sort()).deep.equals(ids.sort())
    expect(notices.items.map(row => row.type).sort()).deep.equals(
      [RECORDING_UPLOAD, PLAYER_ADD_REJECTED, UMPIRE_MISSING_SLOTS].sort()
    )
    expect(notices.hasPending).equals(true)
    expect(notices.nextCursor).equals(null)
    expect(
      JSON.parse(JSON.stringify(await inbox(watched, actor(101), {}, f.clock)))
    ).deep.equals(notices)
    const summary = await f.h.request(
      'GET',
      '/me/notifications/summary',
      undefined,
      101
    )
    expect(summary.status).equals(200)
    expect(await summary.json()).deep.equals({ hasPending: true })
  })

  it('retains live eligibility, sender-only Sent, exact expiry and History precedence', async () => {
    const id = await send()
    const before = await page()
    expect(before.items.map(row => row.requestId)).deep.equals([id])
    expect((await page('', 104)).items).deep.equals([])
    const sent = await page('?sent=1', 102)
    expect(sent.items.map(row => row.requestId)).deep.equals([id])
    await f.h.db
      .updateTable('group_request_sides')
      .set({ approved_by: null, approved_at: null })
      .where('request_id', '=', id)
      .where('scope_type', '=', 'season')
      .execute()
    const accepted = await f.h.request(
      'POST',
      `/relationship-requests/${id}/accept`,
      {},
      101
    )
    expect(accepted.status).equals(200)
    expect((await page()).items).deep.equals([])
    expect(
      (await page('?sent=1', 102)).items.map(row => row.requestId)
    ).deep.equals([id])
    // The approved team half is no longer actionable, but the other half still is.
    expect((await page('', 102)).items.map(row => row.requestId)).deep.equals([
      id
    ])
    await f.h.db
      .updateTable('group_requests')
      .set({ expires_at: new Date(f.clock.now().getTime() + 1) })
      .where('id', '=', id)
      .execute()
    expect((await page('', 102)).items).has.length(1)
    f.advance(1)
    expect((await page('', 102)).items).has.length(0)
    const history = await page('?history=1', 102)
    expect(history.items.find(row => row.requestId === id)?.status).equals(
      'expired'
    )
    expect(
      await inbox(f.h.db, actor(102), { history: true, sent: true }, f.clock)
    ).deep.equals(history)
    const detail = await f.h.request(
      'GET',
      `/me/notifications/${id}`,
      undefined,
      102
    )
    expect(detail.status).equals(200)
    expect(await detail.json()).deep.equals(
      history.items.find(row => row.requestId === id)
    )
  })

  it('pages after authorization across tied timestamps and reminder rank, retaining both cursor formats', async () => {
    const id = await send()
    await copies(id, 6, false)
    // Candidate history recipients do not gain live authority over an unrelated side.
    const hidden = await copies(id, 8, false)
    await f.h.db
      .updateTable('group_request_sides')
      .set({ scope_id: f.standaloneTeam })
      .where('scope_type', '=', 'team')
      .where('request_id', 'in', hidden)
      .execute()
    for (const sourceId of hidden)
      await f.h.db
        .insertInto('notification_events')
        .values({
          id: randomUUID(),
          source_type: 'groupRequest',
          source_id: sourceId,
          revision: 1,
          metadata: '{}',
          recorded_recipients: [userIdOfGumbo(101)],
          created_at: f.clock.now()
        })
        .execute()
    await notice(RECORDING_UPLOAD)
    await notice(PLAYER_ADD_REJECTED)
    const all = await page('?limit=100')
    expect(all.items).has.length(9)
    const seen: Notification[] = []
    let cursor: string | null = null
    do {
      const next = await page(
        `?limit=2${cursor == null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      )
      seen.push(...next.items)
      cursor = next.nextCursor
    } while (cursor != null)
    expect(seen).deep.equals(all.items)
    const last = all.items.at(-1)!
    for (const cursor of [
      `${last.sentAt}|${last.requestId}`,
      `1|${last.sentAt}|${last.requestId}`
    ])
      expect(await page(`?cursor=${encodeURIComponent(cursor)}`)).deep.equals({
        items: [],
        nextCursor: null,
        hasPending: true
      })
    const invalid = await f.h.request(
      'GET',
      '/me/notifications?cursor=invalid',
      undefined,
      101
    )
    expect(invalid.status).equals(403)
  })

  it('keeps applied player adds rejectable just before expiry, including after dismissal, but not at expiry', async () => {
    const id = await recordPlayerAdd(
      f.h.db,
      actor(101),
      {
        kind: 'playerAdd',
        mode: 'roster',
        userId: userIdOfGumbo(103),
        teamId: f.teamA,
        teamName: 'Demo Hawks',
        jersey: null,
        positions: []
      },
      'applied',
      f.clock
    )
    expect(id).not.equals(null)
    await f.h.db
      .updateTable('group_requests')
      .set({ expires_at: new Date(f.clock.now().getTime() + 1) })
      .where('id', '=', id!)
      .execute()
    const pending = await page('', 103)
    expect(
      pending.items.map(row => [row.requestId, row.status, row.canReject])
    ).deep.equals([[id, 'applied', true]])
    expect(
      (await hasPendingNotifications(f.h.db, actor(103), f.clock)).hasPending
    ).equals(true)
    const dismissed = await f.h.request(
      'PUT',
      `/me/notifications/${id}/dismissed`,
      {},
      103
    )
    expect(dismissed.status).equals(204)
    expect((await page('', 103)).items).deep.equals([])
    expect(
      (await page('?history=1', 103)).items.find(row => row.requestId === id)
        ?.canReject
    ).equals(true)
    f.advance(1)
    expect(
      (await page('?history=1', 103)).items.find(row => row.requestId === id)
        ?.canReject
    ).equals(false)
    expect(
      (await hasPendingNotifications(f.h.db, actor(103), f.clock)).hasPending
    ).equals(false)
  })
})
