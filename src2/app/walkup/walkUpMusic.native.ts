import { Platform } from 'react-native'

import { apiBaseUrl } from '../native/config'
import { makeWalkUpMusic } from './makeWalkUpMusic'
import { musicLog } from './musicLog'
import NativeWalkUpMusic from './NativeWalkUpMusic'

export * from './walkUpMusicTypes'
export default makeWalkUpMusic(NativeWalkUpMusic, {
  platform: Platform.OS,
  onReport: musicLog(apiBaseUrl, Platform.OS)
})
