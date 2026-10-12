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

/**
 * Writes this phone's `capabilities()` to the device log once, in a
 * development build: until Record video draws from it, this line is how a
 * test sees the module answer.
 */
let reported = false
export function reportPhoneStreamCapabilities(
  log: (line: string) => void = console.log
): void {
  if (!__DEV__ || reported) return
  reported = true
  phoneStream.capabilities().then(
    ({ supported, deviceModel }) => {
      log(
        `phoneStream capabilities supported=${String(supported)} deviceModel=${deviceModel}`
      )
    },
    () => {}
  )
}
