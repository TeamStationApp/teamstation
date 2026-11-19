import type { DocumentStore } from './cacheStore'

/** The browser has no persistent document files to remove. */
export async function deleteDocumentCaches(_userId: string): Promise<void> {}

/**
 * The web's document cache, which keeps nothing: every read misses and every
 * write is dropped. The browser reads the API each time, and the phone's
 * SQLite file is `cache.native.ts`.
 */
export async function openDocumentCache(
  _userId: string,
  _apiBaseUrl: string
): Promise<DocumentStore> {
  return {
    read: async () => undefined,
    store: async (_key, document) => ({ ...document, pending: false }),
    storeServer: async (_key, document) => ({ ...document, pending: false }),
    // The browser queues nothing, and keeps no schedule set: a write it
    // cannot send fails as before, and a schedule read misses.
    atomically: async () => {
      throw new Error('The web keeps no outbox')
    },
    close: async () => undefined,
    destroy: async () => undefined
  }
}
