import * as Keychain from 'react-native-keychain'

import {
  KEY_SERVICE,
  type KeychainModule,
  nativeKeyStore
} from '../chat/keyStore.native'
import {
  FIXTURE_USER_ID,
  type IdentityProbeResult,
  type IdentityProbeStorage,
  runIdentityStoreProbe
} from './chatIdentityStoreProbeRun'

export const PROBE_SERVICE = 'app.teamstation.chat.compatibility-fixture'
let active = false

/** The per-account fixture slot, never the real chat service. */
export function probeAccountService(userId: string = FIXTURE_USER_ID): string {
  return `${PROBE_SERVICE}.${userId}`
}

/**
 * Maps a store service onto this diagnostic's namespace. The legacy name
 * maps to the bare fixture service so a stray call never opens the real
 * one. Any other name is refused.
 */
export function mapIdentityProbeService(requested?: string): string {
  if (requested === KEY_SERVICE) return PROBE_SERVICE
  const prefix = `${KEY_SERVICE}.`
  if (
    requested != null &&
    requested.startsWith(prefix) &&
    requested.length > prefix.length
  )
    return `${PROBE_SERVICE}.${requested.slice(prefix.length)}`
  throw new Error('Unexpected diagnostic service')
}

/** The normal chat service is never read, written or reset by this diagnostic. */
export async function openIdentityProbeStorage(
  keychain: KeychainModule = Keychain
): Promise<IdentityProbeStorage> {
  if (active) throw new Error('Compatibility diagnostic already running')
  active = true
  let owned = false
  let refuse = false
  const slot = probeAccountService()
  const slotOptions = {
    service: slot,
    cloudSync: true as const
  }
  try {
    if (await keychain.hasGenericPassword(slotOptions)) {
      // Only this diagnostic writes its service, as `chat`: a run stopped
      // before cleanup leaves it behind, and an iOS Keychain item outlives
      // a reinstall. Anything else there is never touched.
      const leftover = await keychain.getGenericPassword(slotOptions)
      if (
        leftover === false ||
        leftover.username !== 'chat' ||
        !(await keychain.resetGenericPassword(slotOptions)) ||
        (await keychain.hasGenericPassword(slotOptions))
      )
        throw new Error('Compatibility diagnostic storage is occupied')
    }
    // Exclusive to this app's diagnostic runner; no existing item is replaced.
    const allocated = await keychain.setGenericPassword('chat', 'allocated', {
      ...slotOptions,
      accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK
    })
    if (allocated === false)
      throw new Error('Compatibility storage unavailable')
    owned = true
    const mapped: KeychainModule = {
      ACCESSIBLE: keychain.ACCESSIBLE,
      hasGenericPassword: async options =>
        await keychain.hasGenericPassword({
          ...options,
          service: mapIdentityProbeService(options?.service)
        }),
      getGenericPassword: async options =>
        await keychain.getGenericPassword({
          ...options,
          service: mapIdentityProbeService(options?.service)
        }),
      setGenericPassword: async (user, password, options) => {
        const target = mapIdentityProbeService(options?.service)
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
          service: mapIdentityProbeService(options?.service)
        })
    }
    return {
      store: nativeKeyStore(mapped),
      install: async text => {
        const saved = await keychain.setGenericPassword('chat', text, {
          ...slotOptions,
          accessible: keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK
        })
        if (saved === false)
          throw new Error('Compatibility storage unavailable')
      },
      fingerprint: async () => {
        const saved = await keychain.getGenericPassword(slotOptions)
        if (saved === false) throw new Error('Compatibility record missing')
        return saved.password
      },
      refuseNextSave: () => {
        refuse = true
      },
      cleanup: async () => {
        try {
          const removed = await keychain.resetGenericPassword(slotOptions)
          if (!removed || (await keychain.hasGenericPassword(slotOptions)))
            throw new Error('Compatibility cleanup failed')
        } finally {
          active = false
        }
      }
    }
  } catch (error) {
    if (owned) await keychain.resetGenericPassword(slotOptions)
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
