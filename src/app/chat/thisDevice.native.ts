import { Platform } from 'react-native'

import type { ChatPlatform } from '../../common/api'

/**
 * How this phone names itself when it registers for chat: "iPhone" or
 * "iPad", or the Android maker and model. The browser's twin reads its user
 * agent (`thisDevice.ts`).
 */
export interface ThisDevice {
  name: string
  platform: ChatPlatform
}

export function thisDevice(): ThisDevice {
  if (Platform.OS === 'android') {
    const { Brand, Model } = Platform.constants
    const name = [Brand, Model].filter(part => part !== '').join(' ')
    return { name: name === '' ? 'Android' : name, platform: 'android' }
  }
  const pad =
    Platform.OS === 'ios' && Platform.constants.interfaceIdiom === 'pad'
  return { name: pad ? 'iPad' : 'iPhone', platform: 'ios' }
}

/**
 * What the device is, sent with a sign-in so node administrators can tell
 * devices apart: a TV by its kind, a phone or tablet as it names itself for
 * chat. The browser's twin sends nothing.
 */
export function signInDeviceModel(): string | undefined {
  if (Platform.isTV) return Platform.OS === 'ios' ? 'Apple TV' : 'Android TV'
  return thisDevice().name
}
