import { PermissionsAndroid, Platform } from 'react-native'

import NativePhoneStream from './NativePhoneStream'
import {
  androidPermissionHost,
  makePhoneStream,
  type PhoneStreamStatus,
  type RadarState,
  type Recordings,
  usePhoneStreamStatusOf,
  useRadarStateOf,
  useRecordingsOf
} from './phoneStreamClient'

export * from './phoneStreamClient'
export { default as PhoneStreamPreview } from './TSPhoneStreamPreviewNativeComponent'

/** The phone's streaming and recording engine, through `TSPhoneStream`. */
export const phoneStream = makePhoneStream(
  NativePhoneStream,
  androidPermissionHost(Platform.OS, Platform.Version, PermissionsAndroid)
)

export const usePhoneStreamStatus = (): PhoneStreamStatus | null =>
  usePhoneStreamStatusOf(phoneStream)
export const useRadarState = (): RadarState | null =>
  useRadarStateOf(phoneStream)
export const useRecordings = (): Recordings => useRecordingsOf(phoneStream)
