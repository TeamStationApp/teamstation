/* global __DEV__ */
import { AppRegistry, LogBox } from 'react-native'

import { TvApp } from '../src/app/tv/TvApp'
// Keep remote-driven visual review clear; diagnostics remain in developer logs.
if (__DEV__) {
  LogBox.ignoreAllLogs(true)
  // This TV is reviewed through its HDMI output; keep Metro status in the logs.
  const loading =
    require('react-native/Libraries/Utilities/DevLoadingView').default
  loading.hide()
  loading.showMessage = () => {}
}

AppRegistry.registerComponent('TeamStationTV', () => TvApp)
