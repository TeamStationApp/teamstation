import {
  ANDROID_DATABASE_PATH,
  type DB,
  IOS_DOCUMENT_PATH,
  open
} from '@op-engineering/op-sqlite'
import { Platform } from 'react-native'
import ReactNativeBlobUtil from 'react-native-blob-util'

import { type CacheFiles, deleteFileCaches, openFileCache } from './cacheFiles'
import type { DocumentStore, SqlExecutor } from './cacheStore'

/** op-sqlite as the cache's executor: every statement inside `transaction`. */
function executorOf(db: DB): SqlExecutor {
  return {
    transaction: async work => {
      let result: Awaited<ReturnType<typeof work>> | undefined
      await db.transaction(async tx => {
        result = await work({
          execute: async (sql, params) => (await tx.execute(sql, params)).rows
        })
      })
      return result!
    },
    close: () => {
      db.close()
    },
    delete: () => {
      db.delete()
    }
  }
}

function nativeCacheFiles(): CacheFiles {
  const location =
    Platform.OS === 'ios'
      ? (IOS_DOCUMENT_PATH as string)
      : (ANDROID_DATABASE_PATH as string)
  const { fs } = ReactNativeBlobUtil
  return {
    list: async () =>
      (await fs.exists(location)) ? await fs.ls(location) : [],
    remove: async name => {
      await fs.unlink(`${location}/${name}`)
    },
    open: name => executorOf(open({ name, location }))
  }
}

/** One API origin, in iOS documents or Android's databases directory. */
export async function openDocumentCache(
  userId: string,
  apiBaseUrl: string
): Promise<DocumentStore> {
  return await openFileCache(userId, apiBaseUrl, nativeCacheFiles())
}

/** Delete all this account's stores without opening a possibly corrupt file. */
export async function deleteDocumentCaches(userId: string): Promise<void> {
  await deleteFileCaches(userId, nativeCacheFiles())
}
