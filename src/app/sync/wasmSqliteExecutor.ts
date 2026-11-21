import sqlite3InitModule from '@sqlite.org/sqlite-wasm'

import type { SqlExecutor, SqlRow } from './cacheStore'

/**
 * The cache's executor in the browser: SQLite compiled to WebAssembly
 * (`@sqlite.org/sqlite-wasm`), one in-memory database per executor, on the
 * page's own thread. An in-memory database needs no worker, no OPFS and no
 * Web Locks; nothing outlives the tab. The same SQL and transactions the
 * phone runs on op-sqlite (`cache.native.ts`).
 */

/** The hashed module file the web build ships (`src/build.mjs`); unset in Node. */
declare const TS_SQLITE_WASM_URL: string | undefined

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>
type Database = InstanceType<Sqlite3['oo1']['DB']>

/**
 * `load` once: its answer is kept for every later call, and a load that
 * failed (a fetch of the module that did not arrive) is tried again on the
 * next call instead of refusing for the page's life.
 */
export function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined
  return async () => {
    loading ??= load().catch((error: unknown) => {
      loading = undefined
      throw error
    })
    return await loading
  }
}

let loaded: Sqlite3 | undefined

const loadSqlite = loadOnce(async () => {
  // The emscripten options the module takes, which its types leave out.
  const init = sqlite3InitModule as unknown as (options: {
    locateFile?: (path: string) => string
    print: (text: string) => void
    printErr: (text: string) => void
  }) => ReturnType<typeof sqlite3InitModule>
  loaded = await init({
    // Where the web build put the module; in Node the package finds its own.
    ...(typeof TS_SQLITE_WASM_URL === 'string'
      ? { locateFile: () => TS_SQLITE_WASM_URL }
      : {}),
    print: () => undefined,
    printErr: () => undefined
  })
  return loaded
})

/**
 * Loads the SQLite module once for the page (or the test process): every
 * executor shares it, and each opens a database of its own.
 */
export async function wasmSqliteReady(): Promise<void> {
  // A browser without it: refused here, before the module's own loader
  // logs its failure as a page error. The session runs uncached.
  if (typeof WebAssembly === 'undefined')
    throw new Error('This browser has no WebAssembly')
  await loadSqlite()
}

/** A new in-memory database, once `wasmSqliteReady` has settled. */
export function openWasmExecutor(): SqlExecutor {
  if (loaded == null)
    throw new Error('SQLite is not loaded yet: await wasmSqliteReady() first')
  const db: Database = new loaded.oo1.DB(':memory:', 'c')
  // One transaction at a time, as op-sqlite queues them.
  let tail: Promise<unknown> = Promise.resolve()
  let open = true
  return {
    transaction: async work => {
      const run = tail.then(async () => {
        if (!open) throw new Error('The database is closed')
        db.exec('BEGIN')
        try {
          const result = await work({
            execute: async (sql, params) =>
              db
                .exec({
                  sql,
                  ...(params == null || params.length === 0
                    ? {}
                    : { bind: params }),
                  rowMode: 'object',
                  returnValue: 'resultRows'
                })
                .map(row => ({ ...(row as SqlRow) }))
          })
          db.exec('COMMIT')
          return result
        } catch (error: unknown) {
          db.exec('ROLLBACK')
          throw error
        }
      })
      tail = run.catch(() => undefined)
      return await run
    },
    close: () => {
      if (!open) return
      open = false
      db.close()
    },
    // Nothing is on disk.
    delete: () => undefined
  }
}

/** Loads the module if need be, then opens a new in-memory database. */
export async function wasmSqliteExecutor(): Promise<SqlExecutor> {
  await wasmSqliteReady()
  return openWasmExecutor()
}
