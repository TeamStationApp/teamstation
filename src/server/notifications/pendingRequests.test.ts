import { expect } from 'chai'
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from 'kysely'
import { describe, it } from 'mocha'

import type { Database } from '../db/database'
import { pendingRequests } from './pendingRequests'

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: db => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler()
  }
})

describe('pending request candidate selection', () => {
  const now = new Date('2027-01-01T00:00:00Z')
  const query = db
    .selectFrom('group_requests')
    .selectAll()
    .where(eb =>
      eb.or([
        eb('sender_id', '=', 'reader'),
        eb('id', '=', 'authorized-request')
      ])
    )
  it('ANDs expiry and actionable states beneath the existing authorized OR, using bound values', () => {
    const compiled = pendingRequests(query, 'pending', now).compile()
    expect(compiled.sql).equals(
      'select * from "group_requests" where ("sender_id" = $1 or "id" = $2) and "expires_at" > $3 and ("status" = $4 or ("kind" = $5 and "status" = $6))'
    )
    expect(compiled.parameters).deep.equals([
      'reader',
      'authorized-request',
      now,
      'pending',
      'playerAdd',
      'applied'
    ])
    expect(compiled.sql).not.contains('limit')
  })
  for (const mode of ['sent', 'history'] as const)
    it(`leaves ${mode} query and bound authorization unchanged`, () => {
      expect(pendingRequests(query, mode, now)).equals(query)
      expect(pendingRequests(query, mode, now).compile()).deep.equals(
        query.compile()
      )
    })
})
