import { useEffect, useState } from 'react'

import { deviceStorage } from '../platform/deviceStorage'
import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'

/** How walk-up songs play on this phone. */
export interface WalkUpPreferences {
  /**
   * Fade Apple Music in and out by moving the phone's volume. Apple's player
   * has no volume of its own, so this is the only way to fade it; some
   * Bluetooth speakers beep at every step, and off means hard starts and
   * stops. Files on an Android phone always fade, on the player's own volume.
   */
  fadeAppleMusic: boolean
}

export const DEFAULT_WALK_UP_PREFERENCES: WalkUpPreferences = {
  fadeAppleMusic: true
}

const KEY = 'gamestation:walkUp:preferences'

/**
 * The walk-up settings, per device, in the same `PreferenceStorage` the
 * scoring settings use. Anything unreadable is the default.
 */
export function walkUpPreferenceStore(storage: PreferenceStorage): {
  read: () => Promise<WalkUpPreferences>
  write: (value: WalkUpPreferences) => Promise<void>
} {
  return {
    async read() {
      try {
        const raw = await storage.getItem(KEY)
        if (raw == null) return DEFAULT_WALK_UP_PREFERENCES
        const value: unknown = JSON.parse(raw)
        if (typeof value !== 'object' || value == null) {
          return DEFAULT_WALK_UP_PREFERENCES
        }
        return {
          fadeAppleMusic:
            !('fadeAppleMusic' in value) || value.fadeAppleMusic !== false
        }
      } catch {
        return DEFAULT_WALK_UP_PREFERENCES
      }
    },
    async write(value) {
      try {
        await storage.setItem(KEY, JSON.stringify(value))
      } catch {
        // Restricted storage keeps the default; it must not block anything.
      }
    }
  }
}

export const walkUpPreferences = walkUpPreferenceStore(deviceStorage)

type Store = ReturnType<typeof walkUpPreferenceStore>
const listeners = new Set<(value: WalkUpPreferences) => void>()

/**
 * The settings and a setter, shared by every screen that asks, so the
 * Account screen's switch reaches a player page already open underneath it.
 * The default until storage has answered.
 */
export function useWalkUpPreferences(
  store: Store = walkUpPreferences
): [WalkUpPreferences, (value: WalkUpPreferences) => void] {
  const [value, setValue] = useState(DEFAULT_WALK_UP_PREFERENCES)
  useEffect(() => {
    let live = true
    store
      .read()
      .then(read => {
        if (live) setValue(read)
      })
      .catch(() => undefined)
    listeners.add(setValue)
    return () => {
      live = false
      listeners.delete(setValue)
    }
  }, [store])
  const set = (next: WalkUpPreferences): void => {
    for (const listener of [...listeners]) listener(next)
    store.write(next).catch(() => undefined)
  }
  return [value, set]
}
