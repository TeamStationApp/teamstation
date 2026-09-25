import AsyncStorage from '@react-native-async-storage/async-storage'

import { scoringPreferenceStore } from './scoringPreferenceStore'

export const scoringPreferences = scoringPreferenceStore(AsyncStorage)
