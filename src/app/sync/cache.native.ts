import {
  ANDROID_DATABASE_PATH,
  type DB,
  IOS_DOCUMENT_PATH,
  open
} from '@op-engineering/op-sqlite'
import { Platform } from 'react-native'

import {
  cacheFileName,
  type DocumentStore,
  openCacheStore,
  type SqlExecutor
} from './cacheStore'

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

/**
 * The signed-in person's cache on the phone: `teamstation-<userId>.sqlite`
 * in the app's documents on iOS and its databases directory on Android.
 */
export async function openDocumentCache(
  userId: string
): Promise<DocumentStore> {
  const db = open({
    name: cacheFileName(userId),
    location:
      Platform.OS === 'ios'
        ? (IOS_DOCUMENT_PATH as string)
        : (ANDROID_DATABASE_PATH as string)
  })
  return await openCacheStore(executorOf(db))
}
