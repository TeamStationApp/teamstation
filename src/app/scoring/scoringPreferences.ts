import { scoringPreferenceStore } from './scoringPreferenceStore'

export const scoringPreferences = scoringPreferenceStore({
  getItem: async key => localStorage.getItem(key),
  setItem: async (key, value) => {
    localStorage.setItem(key, value)
  }
})
