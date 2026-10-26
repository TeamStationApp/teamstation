import Clipboard from '@react-native-clipboard/clipboard'
import { ActionSheetIOS, Linking, Platform } from 'react-native'

import {
  type DirectionsPoint,
  openNativeDirections,
  openNativePointDirections
} from './eventDirectionsNative'

export async function openEventDirections(address: string): Promise<void> {
  await openNativeDirections(address, Platform.OS, Linking, ActionSheetIOS)
}

/**
 * Routes to a point by its coordinates. A development build logs each URL it
 * opens as `[directions] <url>`, which a Debug iOS build writes to the
 * unified log, for the end-to-end test to read.
 */
export async function openPointDirections(
  point: DirectionsPoint
): Promise<void> {
  await openNativePointDirections(
    point,
    Platform.OS,
    {
      canOpenURL: async url => await Linking.canOpenURL(url),
      openURL: async url => {
        if (__DEV__) console.info('[directions] ' + url)
        await Linking.openURL(url)
      }
    },
    ActionSheetIOS
  )
}

export async function copyEventAddress(address: string): Promise<void> {
  Clipboard.setString(address)
}
