import {
  type DocumentStore,
  openCacheStore,
  type SqlExecutor
} from './cacheStore'
import { wasmSqliteExecutor } from './wasmSqliteExecutor'

/**
 * A person's database that their session closed without deleting it (the
 * server refused the session, or another account opened its own), kept in
 * this tab for their next session, as the phone keeps its file, with how
 * many writes it holds unsent.
 */
const kept = new Map<string, { executor: SqlExecutor; unsent: number }>()

const warnOnLeave = (event: BeforeUnloadEvent): void => {
  event.preventDefault()
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  event.returnValue = ''
}

/**
 * The browser's leave warning while a kept database holds unsent writes:
 * its session is closed, so the open queue's warning
 * (`useUnsentEditsWarning`) no longer counts them.
 */
function warnWhileKept(): void {
  if (typeof window?.addEventListener !== 'function') return
  window.removeEventListener('beforeunload', warnOnLeave)
  if ([...kept.values()].some(held => held.unsent > 0))
    window.addEventListener('beforeunload', warnOnLeave)
}

/** Drops `userId`'s kept database: sign-out, or the account deleted. */
export async function deleteDocumentCaches(userId: string): Promise<void> {
  const held = kept.get(userId)
  kept.delete(userId)
  warnWhileKept()
  await held?.executor.close()
}

/**
 * The web's document cache: the phone's documents and outbox
 * (`cacheStore.ts`), in an in-memory SQLite database of this tab's own.
 * Nothing is persisted: closing the tab loses what it holds, unsent edits
 * included, which the leave warning guards. A database its session closes
 * is kept for that person's next open in this tab, and one destroyed (sign
 * out) is gone. The phone's SQLite file is `cache.native.ts`.
 */
export async function openDocumentCache(
  userId: string,
  _apiBaseUrl: string,
  /** The store over the database: `openCacheStore`, or a test's. */
  open: typeof openCacheStore = openCacheStore
): Promise<DocumentStore> {
  const held = kept.get(userId)
  const executor = held?.executor ?? (await wasmSqliteExecutor())
  let closed = false
  // Kept, warning on leave, until it has opened again: a reopen that fails
  // still holds the person's unsent writes.
  const store = await open({
    transaction: async work => await executor.transaction(work),
    close: async () => {
      if (closed) return
      closed = true
      const [row] = await executor.transaction(
        async tx => await tx.execute('SELECT count(*) AS unsent FROM outbox')
      )
      kept.set(userId, { executor, unsent: Number(row?.unsent ?? 0) })
      warnWhileKept()
    },
    // Destroyed: closed, then deleted. Nothing is on disk.
    delete: async () => {
      if (kept.get(userId)?.executor === executor) kept.delete(userId)
      warnWhileKept()
      await executor.close()
    }
  })
  if (held != null && kept.get(userId) === held) {
    kept.delete(userId)
    warnWhileKept()
  }
  return store
}
