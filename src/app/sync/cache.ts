import { type DocumentStore, openCacheStore } from './cacheStore'
import { wasmSqliteExecutor } from './wasmSqliteExecutor'

/** The browser keeps no document files to remove. */
export async function deleteDocumentCaches(_userId: string): Promise<void> {}

/**
 * The web's document cache: the phone's documents and outbox
 * (`cacheStore.ts`), in an in-memory SQLite database of this tab's own.
 * Nothing is persisted: closing the tab loses what it holds, unsent edits
 * included, which the leave warning guards. The phone's SQLite file is
 * `cache.native.ts`.
 */
export async function openDocumentCache(
  _userId: string,
  _apiBaseUrl: string
): Promise<DocumentStore> {
  return await openCacheStore(await wasmSqliteExecutor())
}
