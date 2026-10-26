import * as Keychain from 'react-native-keychain'

import {
  type ChatKeyRecord,
  type ChatKeyStore,
  recordToJson,
  storedRecordFromJson,
  UnreadableKeyRecordError
} from './keyRecord'

/**
 * The phone's chat key store: the whole record as one generic password in
 * the iOS Keychain, or on Android under a Keystore key, through
 * `react-native-keychain`. `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` keeps it
 * readable in the background once the phone has been unlocked since boot,
 * and keeps it out of every backup and every other phone, so a restored
 * backup is a new device that links or resets. The browser keeps the same
 * record in IndexedDB (`keyStore.ts`).
 *
 * The store makes one call to the module at a time. On Android the module
 * saves and reads one at a time, but removes the Keystore key at once, on
 * another thread: a wipe during a save leaves the new record sealed under
 * a key that is gone, and every read after fails its authentication tag
 * until something saves over it.
 */
export const KEY_SERVICE = 'app.teamstation.chat'

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
    'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
  >
}

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

  return {
    async load(): Promise<ChatKeyRecord | undefined> {
      let found: Awaited<ReturnType<KeychainModule['getGenericPassword']>>
      try {
        found = await inTurn(
          async () =>
            await keychain.getGenericPassword({ service: KEY_SERVICE })
        )
      } catch (error) {
        // A Keychain or Keystore that will not answer (locked, unavailable)
        // throws as it is: that is not the record, and resetting would not
        // help. A record its key does not open is the record's fault.
        if (undecryptable(error))
          throw new UnreadableKeyRecordError('undecryptable')
        throw error
      }
      if (found === false) return undefined
      return storedRecordFromJson(found.password)
    },

    async save(record: ChatKeyRecord): Promise<void> {
      const saved = await inTurn(
        async () =>
          await keychain.setGenericPassword('chat', recordToJson(record), {
            service: KEY_SERVICE,
            accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
          })
      )
      if (saved === false) throw new Error('The chat keys could not be saved')
    },

    async wipe(): Promise<void> {
      await inTurn(
        async () =>
          await keychain.resetGenericPassword({ service: KEY_SERVICE })
      )
    },

    async exists(): Promise<boolean> {
      return await inTurn(
        async () => await keychain.hasGenericPassword({ service: KEY_SERVICE })
      )
    }
  }
}

/** This phone's store. */
export const keyStore: ChatKeyStore = nativeKeyStore(Keychain)
