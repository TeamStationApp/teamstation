import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { describe, it } from 'mocha'
import type { Pool } from 'pg'

import type { Database } from '../db/database'
import { approveHistoryAccess, ensureHistoryAccess } from './historyAccess'
import {
  canDistributeEpoch,
  historyGrantsFor,
  postHistoryGrants
} from './historyRecovery'
import { reconcileHistoryRequests } from './historyRequests'

const now = new Date('2026-10-01T00:00:00Z')
const caller = { userId: 'caller', sessionId: 'session' }
const box = {
  requestId: '9007199254740993',
  conversationId: 'chat',
  targetEpoch: 3,
  epoch: 2,
  userId: 'recipient',
  identityId: 'recipient-identity',
  pukGeneration: 1,
  approveHistory: false,
  box: new Uint8Array(80)
}
const request = {
  conversation_id: 'chat',
  user_id: 'recipient',
  identity_id: 'recipient-identity',
  generation: 1,
  segment_start_epoch: 1,
  target_epoch: 3,
  covered_through_epoch: 0,
  filled_at: null,
  superseded_at: null
}
interface Query {
  sql: string
  parameters: readonly unknown[]
}
/** Real PostgreSQL query compiler with a deterministic, disconnected query boundary. */
function fixture(
  options: {
    held?: boolean
    eligible?: boolean
    member?: boolean
    linked?: boolean
    approval?: boolean
    request?:
      | (Omit<typeof request, 'filled_at' | 'superseded_at'> & {
          filled_at: Date | null
          superseded_at: Date | null
        })
      | undefined
    list?: unknown[]
  } = {}
): { db: Kysely<Database>; queries: Query[] } {
  const queries: Query[] = []
  const connection = {
    release: () => {},
    query: async (
      sql: string,
      parameters: readonly unknown[] = []
    ): Promise<{ rows: unknown[]; command: string; rowCount: number }> => {
      queries.push({ sql, parameters })
      let rows: unknown[] = []
      if (sql.includes('from "users"'))
        rows =
          options.eligible === false
            ? []
            : [{ birth_year: 1990, birth_month: 1 }]
      else if (sql.includes('from "chat_conversations"'))
        rows = [
          {
            id: parameters[0],
            kind: 'dm',
            scope_id: null,
            closed_at: null,
            needs_rotation: false
          }
        ]
      else if (sql.includes('from "chat_members"'))
        rows =
          options.member === false
            ? []
            : [{ user_id: parameters[1], conversation_id: 'chat' }]
      else if (sql.includes('from "chat_devices"'))
        rows = options.linked === false ? [] : [{ id: 'device' }]
      else if (sql.includes('from "chat_identities"'))
        rows = [
          {
            identityId: 'caller-identity',
            identityKey: new Uint8Array(32),
            generation: 1
          }
        ]
      else if (sql.includes('from "chat_user_key_boxes"'))
        rows = [{ id: 'device' }]
      else if (sql.includes('as held'))
        rows = [{ held: options.held !== false }]
      else if (sql.includes('from chat_history_requests where id='))
        rows = Object.hasOwn(options, 'request')
          ? options.request == null
            ? []
            : [options.request]
          : [request]
      else if (sql.includes('r.id::text')) rows = options.list ?? []
      else if (sql.includes('from "chat_history_access"'))
        rows = [{ requires_approval: options.approval === true }]
      return { rows, command: 'SELECT', rowCount: rows.length }
    }
  }
  const pool = { connect: async () => connection, end: async () => {} }
  return {
    db: new Kysely<Database>({
      dialect: new PostgresDialect({ pool: pool as unknown as Pool })
    }),
    queries
  }
}
async function rejected(
  options: Parameters<typeof fixture>[0],
  change: Partial<typeof box>,
  reason: string
): Promise<void> {
  const { db, queries } = fixture(options)
  try {
    await postHistoryGrants(db, caller, [{ ...box, ...change }], now)
    expect.fail('expected refusal')
  } catch (error) {
    expect((error as { details?: { reason: string } }).details?.reason).equals(
      reason
    )
  }
  expect(queries.some(q => q.sql === 'rollback')).equals(true)
  expect(
    queries.some(q => q.sql.startsWith('insert into "chat_epoch_boxes"'))
  ).equals(false)
  await db.destroy()
}
describe('historical grant orchestration with a disconnected database', () => {
  it('binds access and segment reconciliation to the conversation and identity', async () => {
    const { db, queries } = fixture()
    await ensureHistoryAccess(db, 'chat')
    await approveHistoryAccess(
      db,
      'chat',
      'recipient',
      'identity',
      'approver',
      now
    )
    await reconcileHistoryRequests(db, 'chat', now)
    const approval = queries.find(q =>
      q.sql.startsWith('update "chat_history_access"')
    )!
    expect(approval.parameters).deep.equals([
      false,
      'approver',
      now,
      'chat',
      'recipient',
      'identity',
      true
    ])
    expect(queries.filter(q => q.sql.includes('superseded_at=')).length).equals(
      1
    )
    expect(
      queries.find(q => q.sql.includes('with segments'))?.parameters
    ).includes('chat')
    expect(
      queries.find(q => q.sql.includes('with coverage'))?.parameters
    ).includes(now)
    await db.destroy()
  })
  it('checks the actual supplied epoch using bound values', async () => {
    for (const held of [true, false]) {
      const { db, queries } = fixture({ held })
      expect(
        await canDistributeEpoch(db, 'chat', 'caller', 'identity', 2)
      ).equals(held)
      expect(queries[0].parameters).deep.equals([
        'chat',
        'caller',
        'identity',
        2,
        2
      ])
      await db.destroy()
    }
  })
  it('keeps partial results open and completes only at the immutable tip', async () => {
    for (const epoch of [2, 3]) {
      const { db, queries } = fixture()
      const answer = await postHistoryGrants(
        db,
        caller,
        [{ ...box, epoch }],
        now
      )
      expect(answer).deep.equals({
        filled: epoch === 3 ? 1 : 0,
        results: [
          {
            requestId: box.requestId,
            coveredThroughEpoch: epoch,
            status: epoch === 3 ? 'completed' : 'partial'
          }
        ]
      })
      const save = queries.find(q =>
        q.sql.startsWith('update "chat_history_requests"')
      )!
      expect(save.parameters).deep.equals([
        epoch,
        epoch === 3 ? now : null,
        box.requestId
      ])
      expect(queries.at(-1)?.sql).equals('commit')
      expect(queries.findIndex(q => q.sql.includes('for update'))).lessThan(
        queries.findIndex(q => q.sql.includes('from "chat_devices"'))
      )
      await db.destroy()
    }
  })
  it('requires matching immutable request fields and a historical distribution path', async () => {
    await rejected({ request: undefined }, {}, 'historyTarget')
    for (const change of [
      { conversationId: 'other' },
      { userId: 'other' },
      { identityId: 'other' },
      { pukGeneration: 2 },
      { targetEpoch: 4 },
      { epoch: 0 },
      { epoch: 4 }
    ])
      await rejected({}, change, 'historyTarget')
    await rejected({ held: false }, {}, 'notHolder')
    await rejected({ linked: false }, {}, 'notHolder')
  })
  it('requires explicit distinct-user approval, in the same transaction as a grant', async () => {
    await rejected({ approval: true }, {}, 'notApprover')
    await rejected(
      { approval: true, request: { ...request, user_id: 'caller' } },
      { userId: 'caller', approveHistory: true },
      'notApprover'
    )
    const { db, queries } = fixture({ approval: true })
    await postHistoryGrants(db, caller, [{ ...box, approveHistory: true }], now)
    const approved = queries.findIndex(q =>
      q.sql.startsWith('update "chat_history_access"')
    )
    expect(approved).greaterThan(0)
    expect(approved).lessThan(
      queries.findIndex(q => q.sql.startsWith('insert into "chat_epoch_boxes"'))
    )
    await db.destroy()
  })
  it('does not rewrite superseded or already-covered deliveries', async () => {
    for (const [patch, status] of [
      [{ superseded_at: now }, 'skipped'],
      [{ filled_at: now }, 'alreadyCovered'],
      [{ covered_through_epoch: 2 }, 'alreadyCovered']
    ] as const) {
      const { db, queries } = fixture({
        request: { ...request, ...patch }
      })
      expect(
        (await postHistoryGrants(db, caller, [box], now)).results[0].status
      ).equals(status)
      expect(
        queries.some(q => q.sql.startsWith('insert into "chat_epoch_boxes"'))
      ).equals(false)
      await db.destroy()
    }
  })
  it('pages opaque request IDs without rounding and encodes public key material', async () => {
    const row = {
      id: box.requestId,
      conversationId: 'chat',
      segmentStartEpoch: 1,
      targetEpoch: 3,
      coveredThroughEpoch: 0,
      userId: 'recipient',
      identityId: 'recipient-identity',
      identityKey: new Uint8Array(32),
      pukGeneration: 1,
      pukPublicKey: new Uint8Array(32),
      pukSignature: new Uint8Array(64),
      requiresApproval: true,
      openedAt: now
    }
    const { db } = fixture({ list: [row, { ...row, id: '9007199254740994' }] })
    const answer = await historyGrantsFor(db, caller, '0', 1, now)
    expect(answer.nextCursor).equals(box.requestId)
    expect(answer.requests).length(1)
    expect(answer.requests[0]).include({
      canApprove: true,
      openedAt: now.toISOString(),
      identityKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    })
    await db.destroy()
    const empty = fixture({ eligible: false })
    expect(await historyGrantsFor(empty.db, caller, '0', 100, now)).deep.equals(
      { requests: [], nextCursor: null }
    )
    await empty.db.destroy()
  })
})
