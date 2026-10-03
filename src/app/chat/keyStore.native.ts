import * as Keychain from 'react-native-keychain'

import {
  type ChatKeyRecord,
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from './keyRecord'

/**
 * The phone's chat key store: the whole record as one generic password in
 * the iOS Keychain, or on Android under a Keystore key, through
 * `react-native-keychain`. `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` keeps it
 * readable in the background once the phone has been unlocked since boot,
 * and keeps it out of every backup and every other phone, so a restored
 * backup is a new device that links or resets. The browser keeps the same
 * record in IndexedDB (`keyStore.ts`).
 */
export const KEY_SERVICE = 'app.teamstation.chat'

/** The part of `react-native-keychain` this store uses. */
export type KeychainModule = Pick<
  typeof Keychain,
  'getGenericPassword' | 'setGenericPassword' | 'resetGenericPassword'
> & {
  ACCESSIBLE: Pick<
    typeof Keychain.ACCESSIBLE,
    'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
  >
}

export function nativeKeyStore(keychain: KeychainModule): ChatKeyStore {
  return {
    async load(): Promise<ChatKeyRecord | undefined> {
      const found = await keychain.getGenericPassword({ service: KEY_SERVICE })
      if (found === false) return undefined
      try {
        return recordFromJson(found.password)
      } catch {
        // Not a record this app wrote: as good as none.
        return undefined
      }
    },

    async save(record: ChatKeyRecord): Promise<void> {
      const saved = await keychain.setGenericPassword(
        'chat',
        recordToJson(record),
        {
          service: KEY_SERVICE,
          accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
        }
      )
      if (saved === false) throw new Error('The chat keys could not be saved')
    },

    async wipe(): Promise<void> {
      await keychain.resetGenericPassword({ service: KEY_SERVICE })
    }
  }
}

/** This phone's store. */
export const keyStore: ChatKeyStore = nativeKeyStore(Keychain)
