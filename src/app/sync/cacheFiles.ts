import {
  cacheFileName,
  cacheFilePrefix,
  type DocumentStore,
  legacyCacheFileName,
  openCacheStore,
  type SqlExecutor
} from './cacheStore'

/** Files in the platform's document database directory. Names are basenames. */
export interface CacheFiles {
  list: () => Promise<string[]>
  remove: (name: string) => Promise<void>
  open: (name: string) => SqlExecutor
}

function legacyFiles(userId: string): string[] {
  const name = legacyCacheFileName(userId)
  return [name, `${name}-wal`, `${name}-shm`, `${name}-journal`]
}

async function removeFiles(
  files: Pick<CacheFiles, 'list' | 'remove'>,
  matches: (file: string) => boolean
): Promise<void> {
  const errors: unknown[] = []
  for (const file of await files.list()) {
    if (!matches(file)) continue
    try {
      await files.remove(file)
    } catch (error) {
      errors.push(error)
    }
  }
  // Report failures after attempting all matching files.
  if (errors.length > 0) throw errors[0]
}

/** Sign-out cleanup must also work when the current database cannot open. */
export async function deleteFileCaches(
  userId: string,
  files: Pick<CacheFiles, 'list' | 'remove'>
): Promise<void> {
  const legacy = legacyFiles(userId)
  const prefix = cacheFilePrefix(userId)
  await removeFiles(
    files,
    file =>
      legacy.includes(file) ||
      (file.startsWith(prefix) &&
        /^[a-f0-9]{64}\.sqlite(?:-(?:wal|shm|journal))?$/.test(
          file.slice(prefix.length)
        ))
  )
}

/**
 * Opens this account's store for this server. A legacy file has no reliable
 * server identity, so none of its documents or queued writes are imported.
 */
export async function openFileCache(
  userId: string,
  apiBaseUrl: string,
  files: CacheFiles
): Promise<DocumentStore> {
  const name = cacheFileName(userId, apiBaseUrl)
  const legacy = legacyFiles(userId)
  // Nothing reads a legacy file, so one left behind must not cost this
  // session its store; sign-out's sweep tries it again.
  await removeFiles(files, file => legacy.includes(file)).catch(
    (error: unknown) => {
      console.warn('Legacy document cache not removed:', error)
    }
  )
  const executor = files.open(name)
  let store: DocumentStore
  try {
    store = await openCacheStore(executor)
  } catch (error) {
    await executor.close()
    throw error
  }
  return {
    ...store,
    destroy: async () => {
      await store.destroy()
      // Sign-out also discards this person's closed stores from other builds
      // on this device. Never match another account or an unrelated file.
      await deleteFileCaches(userId, files)
    }
  }
}
