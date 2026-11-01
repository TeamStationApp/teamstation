/* global __DEV__ */
import { AppRegistry, LogBox } from 'react-native'

import { TvApp } from '../src/app/tv/TvApp'
// Keep remote-driven visual review clear; diagnostics remain in developer logs.
if (__DEV__) LogBox.ignoreAllLogs(true)

AppRegistry.registerComponent('TeamStationTV', () => TvApp)
