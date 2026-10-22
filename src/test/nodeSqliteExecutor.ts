import { rmSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import type { SqlExecutor } from '../app/sync/cacheStore'

/**
 * The phone cache's executor over `node:sqlite`, for the tests: the same SQL
 * and transactions op-sqlite runs on the phone, against a file on disk.
 */
export function nodeSqliteExecutor(path: string): SqlExecutor & {
  db: DatabaseSync
} {
  const db = new DatabaseSync(path)
  return {
    db,
    transaction: async work => {
      db.exec('BEGIN')
      try {
        const result = await work({
          execute: async (sql, params = []) => {
            const statement = db.prepare(sql)
            const values = params as SQLInputValue[]
            if (statement.columns().length > 0) return statement.all(...values)
            statement.run(...values)
            return []
          }
        })
        db.exec('COMMIT')
        return result
      } catch (error: unknown) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    close: () => {
      db.close()
    },
    delete: () => {
      rmSync(path, { force: true })
    }
  }
}
