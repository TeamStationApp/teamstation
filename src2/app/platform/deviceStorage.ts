import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'

/**
 * Small settings kept on this device, not on the account: the browser's
 * `localStorage` here, `AsyncStorage` on a phone.
 *
 * A storage that refuses — private browsing, a quota — reads as empty and
 * drops writes, so a setting falls back to its default rather than failing.
 */
export const deviceStorage: PreferenceStorage = {
  getItem: async key => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: async (key, value) => {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // The default stands.
    }
  }
}
