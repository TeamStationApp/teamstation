import { exec } from 'child_process'
import type { SyncedDocument } from 'edge-server-tools'
import type nano from 'nano'

export const THIRTY_SECONDS = 30 * 1000
const ONE_MINUTE = 60 * 1000

/**
 * Removes _id and _rev from a CouchDb document.
 */
export function cleanCouchDoc<T>(doc: T & nano.Document): T {
  const out = { ...doc } as any
  delete out._id
  delete out._rev
  return out as T
}

/**
 * Helps TypeScript see that Array.filter is removing undefined values.
 */
export function exists<T>(x: T | null | undefined): x is T {
  return x != null
}

/**
 * Calls the provided function,
 * turning exceptions into undefined return values.
 */
export function safelyCall<In extends any[], Out>(
  f: (...args: In) => Out,
  ...args: In
): Out | undefined {
  try {
    return f(...args)
  } catch (e) {}
}

export const logger = (...args: any[]): void => {
  const isoDate = new Date().toISOString()
  console.log(`${isoDate}:`, ...args)
}

/**
 * Create an interval to manually refresh the synced document.
 * This is a workaround in case we lose the connection to the CouchDB changes feed.
 */
export const createSyncInterval = (
  syncedDocument: SyncedDocument<unknown>,
  db: nano.DocumentScope<any>,
  interval: number = 30 * ONE_MINUTE
): void => {
  syncedDocument
    .sync(db)
    .then(() => {
      setInterval(() => {
        syncedDocument.sync(db).catch((e: unknown) => {
          console.error('interval sync error', syncedDocument.id, e)
        })
      }, interval)
    })
    .catch((e: unknown) => {
      console.error('createSyncInterval error', syncedDocument.id, e)
    })
}

export const union = <T>(a: Set<T>, b: Set<T>): Set<T> =>
  new Set([...Array.from(a), ...Array.from(b)])
export const intersection = <T>(a: Set<T>, b: Set<T>): Set<T> =>
  new Set([...Array.from(a)].filter(x => b.has(x)))
export const difference = <T>(a: Set<T>, b: Set<T>): Set<T> =>
  new Set([...Array.from(a)].filter(x => !b.has(x)))

export const execute = async (command: string): Promise<string> => {
  return await new Promise((resolve, reject) => {
    exec(command, (_error, stdout, stderr) => {
      if (stderr !== '') {
        resolve(stderr)
        return
      }
      resolve(stdout)
    })
  })
}
