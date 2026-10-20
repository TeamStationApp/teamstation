import { scoringPreferenceStore } from './scoringPreferenceStore'

export const scoringPreferences = scoringPreferenceStore({
  getItem: async key => localStorage.getItem(key),
  removeItem: async key => {
    localStorage.removeItem(key)
  },
  setItem: async (key, value) => {
    localStorage.setItem(key, value)
  }
})
