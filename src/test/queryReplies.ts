import { expect } from 'chai'
import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from 'kysely'

import type { Database } from '../server/db/database'

/** Each expected query supplies rows from an independent boundary stub, without Postgres or HTTP. */
export type QueryStep = [string, unknown[], ((q: CompiledQuery) => void)?]
export async function withQueryReplies(
  steps: QueryStep[] | ((query: CompiledQuery) => unknown[]),
  run: (db: Kysely<Database>) => Promise<void>
): Promise<void> {
  class ReplyDriver extends DummyDriver {
    async acquireConnection(): Promise<DatabaseConnection> {
      const conn = await super.acquireConnection()
      return {
        async executeQuery<R>(query: CompiledQuery) {
          if (typeof steps === 'function') return { rows: steps(query) as R[] }
          const next = steps.shift()
          if (next == null) throw new Error('Unexpected SQL: ' + query.sql)
          expect(query.sql).includes(next[0])
          next[2]?.(query)
          return { rows: next[1] as R[] }
        },
        streamQuery: conn.streamQuery.bind(conn)
      }
    }
  }
  const db = new Kysely<Database>({
    dialect: {
      createDriver: () => new ReplyDriver(),
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: instance => new PostgresIntrospector(instance),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  })
  try {
    await run(db)
    if (Array.isArray(steps)) expect(steps).deep.equals([])
  } finally {
    await db.destroy()
  }
}
