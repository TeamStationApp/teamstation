import * as Keychain from 'react-native-keychain'

import {
  type ChatKeyRecord,
  type ChatKeyStore,
  recordToJson,
  storedRecordFromJson,
  UnreadableKeyRecordError
} from './keyRecord'

/**
 * The phone's chat key store: one generic password per account in the iOS
 * Keychain, or on Android under a Keystore key, through
 * `react-native-keychain`. The service is `app.teamstation.chat.<userId>`.
 * `cloudSync` puts it in iCloud Keychain, and `AFTER_FIRST_UNLOCK` includes
 * it in an encrypted backup, so a restored phone resumes the same device.
 * On Android `cloudSync` is ignored and the Keystore entry stays on that
 * phone across sign-out. A record saved before accounts had their own
 * service sits at `app.teamstation.chat`, without `cloudSync`, and is copied
 * into the account's service the first time that account is read. The
 * browser keeps the same records in IndexedDB (`keyStore.ts`).
 *
 * The store makes one call to the module at a time. On Android the module
 * saves and reads one at a time, but removes the Keystore key at once, on
 * another thread: a wipe during a save leaves the new record sealed under
 * a key that is gone, and every read after fails its authentication tag
 * until something saves over it.
 */
export const KEY_SERVICE = 'app.teamstation.chat'

/** The Keychain service of one account's record. */
export function accountKeyService(userId: string): string {
  return `${KEY_SERVICE}.${userId}`
}

/** The part of `react-native-keychain` this store uses. */
export type KeychainModule = Pick<
  typeof Keychain,
  | 'getGenericPassword'
  | 'hasGenericPassword'
  | 'setGenericPassword'
  | 'resetGenericPassword'
> & {
  ACCESSIBLE: Pick<
    typeof Keychain.ACCESSIBLE,
    'AFTER_FIRST_UNLOCK' | 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
  >
}

type Password = false | { password: string }

/**
 * Whether the Android Keystore refused the saved record itself: it does
 * not open under its key (a failed authentication tag), which no later
 * read changes.
 */
function undecryptable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const { code } = error as { code?: unknown }
  return (
    (code === 'E_CRYPTO_FAILED' ||
      `${error.name} ${error.message}`.includes('CryptoFailedException')) &&
    /decryption failed|authentication tag verification failed/i.test(
      error.message
    )
  )
}

export function nativeKeyStore(keychain: KeychainModule): ChatKeyStore {
  let queue: Promise<unknown> = Promise.resolve()
  /** Runs `call` after every call before it, whether or not they failed. */
  const inTurn = async <T>(call: () => Promise<T>): Promise<T> => {
    const run = queue.then(call)
    queue = run.catch(() => undefined)
    return await run
  }

  const account = (
    userId: string
  ): { service: string; cloudSync: true } => ({
    service: accountKeyService(userId),
    cloudSync: true
  })

  async function readPassword(
    options: { service: string; cloudSync?: boolean }
  ): Promise<string | undefined> {
    let found: Password
    try {
      found = await keychain.getGenericPassword(options)
    } catch (error) {
      // A Keychain or Keystore that will not answer (locked, unavailable)
      // throws as it is: that is not the record, and resetting would not
      // help. A record its key does not open is the record's fault.
      if (undecryptable(error))
        throw new UnreadableKeyRecordError('undecryptable')
      throw error
    }
    if (found === false) return undefined
    return found.password
  }

  /**
   * The legacy service still holds `userId`'s record, left by a copy that
   * already committed. Delete it. An unreadable legacy item, or another
   * account's, stays.
   */
  async function dropLegacyIfOwner(userId: string): Promise<void> {
    if (!(await keychain.hasGenericPassword({ service: KEY_SERVICE }))) return
    let password: string | undefined
    try {
      password = await readPassword({ service: KEY_SERVICE })
    } catch (error) {
      if (error instanceof UnreadableKeyRecordError) return
      throw error
    }
    if (password == null) return
    let record: ChatKeyRecord
    try {
      record = storedRecordFromJson(password)
    } catch (error) {
      if (error instanceof UnreadableKeyRecordError) return
      throw error
    }
    if (record.userId !== userId) return
    if (!(await keychain.resetGenericPassword({ service: KEY_SERVICE })))
      throw new Error('The legacy chat keys could not be removed')
  }

  /**
   * Copies a legacy record for `userId` into that account's service, then
   * deletes the legacy item. A failed copy leaves the legacy item. A failed
   * delete leaves the copy, and the next read finishes it.
   */
  async function migrate(userId: string): Promise<ChatKeyRecord | undefined> {
    if (!(await keychain.hasGenericPassword({ service: KEY_SERVICE })))
      return undefined
    const password = await readPassword({ service: KEY_SERVICE })
    if (password == null) return undefined
    const record = storedRecordFromJson(password)
    if (record.userId !== userId) return undefined
    const saved = await keychain.setGenericPassword('chat', password, {
      ...account(userId),
      accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK
    })
    if (saved === false) throw new Error('The chat keys could not be saved')
    await dropLegacyIfOwner(userId)
    return record
  }

  return {
    async load(userId: string): Promise<ChatKeyRecord | undefined> {
      return await inTurn(async () => {
        const password = await readPassword(account(userId))
        if (password != null) {
          const record = storedRecordFromJson(password)
          await dropLegacyIfOwner(userId)
          return record
        }
        return await migrate(userId)
      })
    },

    async save(record: ChatKeyRecord): Promise<void> {
      const saved = await inTurn(
        async () =>
          await keychain.setGenericPassword('chat', recordToJson(record), {
            ...account(record.userId),
            accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK
          })
      )
      if (saved === false) throw new Error('The chat keys could not be saved')
    },

    async wipe(userId: string): Promise<void> {
      await inTurn(
        async () => await keychain.resetGenericPassword(account(userId))
      )
    },

    async exists(userId: string): Promise<boolean> {
      return await inTurn(async () => {
        if (await keychain.hasGenericPassword(account(userId))) {
          await dropLegacyIfOwner(userId)
          return true
        }
        return (await migrate(userId)) != null
      })
    },

    async discardLegacy(userId: string): Promise<void> {
      await inTurn(async () => {
        if (!(await keychain.hasGenericPassword({ service: KEY_SERVICE }))) {
          await keychain.resetGenericPassword({ service: KEY_SERVICE })
          return
        }
        let remove = false
        try {
          const password = await readPassword({ service: KEY_SERVICE })
          if (password == null) remove = true
          else remove = storedRecordFromJson(password).userId === userId
        } catch (error) {
          if (!(error instanceof UnreadableKeyRecordError)) throw error
          remove = true
        }
        if (!remove) return
        if (!(await keychain.resetGenericPassword({ service: KEY_SERVICE })))
          throw new Error('The legacy chat keys could not be removed')
      })
    }
  }
}

/** This phone's store. */
export const keyStore: ChatKeyStore = nativeKeyStore(Keychain)
