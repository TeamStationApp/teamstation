import * as Keychain from 'react-native-keychain'

import {
  KEY_SERVICE,
  type KeychainModule,
  nativeKeyStore
} from '../chat/keyStore.native'
import {
  type IdentityProbeResult,
  type IdentityProbeStorage,
  runIdentityStoreProbe
} from './chatIdentityStoreProbeRun'

export const PROBE_SERVICE = 'app.teamstation.chat.compatibility-fixture'
let active = false

/** The normal chat service is never read, written or reset by this diagnostic. */
export async function openIdentityProbeStorage(
  keychain: KeychainModule = Keychain
): Promise<IdentityProbeStorage> {
  if (active) throw new Error('Compatibility diagnostic already running')
  active = true
  let owned = false
  let refuse = false
  const service = (requested?: string): string => {
    if (requested !== KEY_SERVICE)
      throw new Error('Unexpected diagnostic service')
    return PROBE_SERVICE
  }
  try {
    if (await keychain.hasGenericPassword({ service: PROBE_SERVICE }))
      throw new Error('Compatibility diagnostic storage is occupied')
    // Exclusive to this app's diagnostic runner; no existing item is replaced.
    const allocated = await keychain.setGenericPassword('chat', 'allocated', {
      service: PROBE_SERVICE,
      accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
    })
    if (allocated === false)
      throw new Error('Compatibility storage unavailable')
    owned = true
    const mapped: KeychainModule = {
      ACCESSIBLE: keychain.ACCESSIBLE,
      hasGenericPassword: async options =>
        await keychain.hasGenericPassword({
          ...options,
          service: service(options?.service)
        }),
      getGenericPassword: async options =>
        await keychain.getGenericPassword({
          ...options,
          service: service(options?.service)
        }),
      setGenericPassword: async (user, password, options) => {
        const target = service(options?.service)
        if (refuse) {
          refuse = false
          return false
        }
        return await keychain.setGenericPassword(user, password, {
          ...options,
          service: target
        })
      },
      resetGenericPassword: async options =>
        await keychain.resetGenericPassword({
          ...options,
          service: service(options?.service)
        })
    }
    return {
      store: nativeKeyStore(mapped),
      install: async text => {
        const saved = await keychain.setGenericPassword('chat', text, {
          service: PROBE_SERVICE,
          accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
        })
        if (saved === false)
          throw new Error('Compatibility storage unavailable')
      },
      fingerprint: async () => {
        const saved = await keychain.getGenericPassword({
          service: PROBE_SERVICE
        })
        if (saved === false) throw new Error('Compatibility record missing')
        return saved.password
      },
      refuseNextSave: () => {
        refuse = true
      },
      cleanup: async () => {
        try {
          const removed = await keychain.resetGenericPassword({
            service: PROBE_SERVICE
          })
          if (
            !removed ||
            (await keychain.hasGenericPassword({ service: PROBE_SERVICE }))
          )
            throw new Error('Compatibility cleanup failed')
        } finally {
          active = false
        }
      }
    }
  } catch (error) {
    if (owned) await keychain.resetGenericPassword({ service: PROBE_SERVICE })
    active = false
    throw error
  }
}

export async function probeIdentityStorage(
  signal: AbortSignal
): Promise<IdentityProbeResult> {
  return await runIdentityStoreProbe(
    async () => await openIdentityProbeStorage(),
    signal
  )
}
