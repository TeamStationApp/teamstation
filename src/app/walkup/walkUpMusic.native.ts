import { Platform } from 'react-native'

import { makeWalkUpMusic } from './makeWalkUpMusic'
import { musicLog } from './musicLog'
import NativeWalkUpMusic from './NativeWalkUpMusic'

export * from './walkUpMusicTypes'
export default makeWalkUpMusic(NativeWalkUpMusic, {
  platform: Platform.OS,
  ...musicLog()
})
