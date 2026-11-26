import { Platform, Settings } from 'react-native'

import { developBuild } from '../platform/developBuild'

export function supportsSystemTabBar(): boolean {
  return (
    Number.parseInt(String(Platform.Version), 10) >= 26 &&
    !((__DEV__ || developBuild) && Settings.get('TSNavRenderer') === 'capsule')
  )
}
