import type { SqlExecutor, SqlRow, SqlValue } from '../app/sync/cacheStore'
import {
  openWasmExecutor,
  wasmSqliteReady
} from '../app/sync/wasmSqliteExecutor'
import { nodeSqliteExecutor } from './nodeSqliteExecutor'

/**
 * The cache's executor for a test: `node:sqlite` on a file, as the phone's
 * op-sqlite runs, or with `TS_TEST_SQLITE=wasm` the web's SQLite WASM on an
 * in-memory database (`path` then means nothing: nothing is kept). A suite
 * that runs on both awaits `testSqliteReady` first, in a `before`, so the
 * module its own bundle carries is the one loaded.
 */
export function testSqliteExecutor(path: string): SqlExecutor {
  return onWasm() ? openWasmExecutor() : nodeSqliteExecutor(path)
}

/** Whether this run is on the web's SQLite WASM. */
export function onWasm(): boolean {
  return process.env.TS_TEST_SQLITE === 'wasm'
}

/** Loads SQLite WASM when the run is on it; nothing otherwise. */
export async function testSqliteReady(): Promise<void> {
  if (onWasm()) await wasmSqliteReady()
}

/** One statement in a transaction of its own, answering its rows. */
export async function sql(
  executor: SqlExecutor,
  statement: string,
  params: SqlValue[] = []
): Promise<SqlRow[]> {
  return await executor.transaction(
    async tx => await tx.execute(statement, params)
  )
}
