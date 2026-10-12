import Clipboard from '@react-native-clipboard/clipboard'
import { ActionSheetIOS, Linking, Platform } from 'react-native'

import { openNativeDirections } from './eventDirectionsNative'

export async function openEventDirections(address: string): Promise<void> {
  await openNativeDirections(address, Platform.OS, Linking, ActionSheetIOS)
}

export async function copyEventAddress(address: string): Promise<void> {
  Clipboard.setString(address)
}
