import { deviceStorage } from '../platform/deviceStorage'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'

/** What this device has already shown about keeping songs on the phone. */
export interface ReadinessFlags {
  /** The Apple Music settings walkthrough has been closed here. */
  onboarded: boolean
  /** The "songs still need to be downloaded" notice has appeared here. */
  promptShown: boolean
}

export const NO_READINESS_FLAGS: ReadinessFlags = {
  onboarded: false,
  promptShown: false
}

const KEY = 'teamstation:walkUp:readiness'

export interface ReadinessStore {
  read: () => Promise<ReadinessFlags>
  write: (value: ReadinessFlags) => Promise<void>
}

/**
 * The two flags, per device, in the storage the other walk-up settings use,
 * so a new phone shows both again. Anything unreadable is neither shown.
 */
export function readinessStore(storage: PreferenceStorage): ReadinessStore {
  return {
    async read() {
      try {
        const raw = await storage.getItem(KEY)
        if (raw == null) return NO_READINESS_FLAGS
        const value: unknown = JSON.parse(raw)
        if (typeof value !== 'object' || value == null) {
          return NO_READINESS_FLAGS
        }
        return {
          onboarded: 'onboarded' in value && value.onboarded === true,
          promptShown: 'promptShown' in value && value.promptShown === true
        }
      } catch {
        return NO_READINESS_FLAGS
      }
    },
    async write(value) {
      try {
        await storage.setItem(KEY, JSON.stringify(value))
      } catch {
        // Restricted storage shows them again; it must not block anything.
      }
    }
  }
}

export const walkUpReadiness = readinessStore(deviceStorage)

/** Records that the walkthrough has been seen on this device. */
export async function markOnboarded(store: ReadinessStore): Promise<void> {
  const flags = await store.read()
  await store.write({ ...flags, onboarded: true })
}
