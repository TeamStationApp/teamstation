import type { DocumentStore } from './cacheStore'

/**
 * The web's document cache, which keeps nothing: every read misses and every
 * write is dropped. The browser reads the API each time, and the phone's
 * SQLite file is `cache.native.ts`.
 */
export async function openDocumentCache(
  _userId: string
): Promise<DocumentStore> {
  return {
    read: async () => undefined,
    store: async (_key, document) => ({ ...document, pending: false }),
    close: async () => undefined,
    destroy: async () => undefined
  }
}
