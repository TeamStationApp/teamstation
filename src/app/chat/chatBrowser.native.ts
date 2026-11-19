import { NativeModules, Platform } from 'react-native'

import { PRIMARY_HOST } from '../../common/primaryUrl'
import { appOrigin } from '../native/config'
import ChatBrowser from './NativeChatBrowser'

export const chatAppOrigin = (): string =>
  appOrigin ?? 'https://' + PRIMARY_HOST

export async function openChatBrowser(url: string): Promise<void> {
  if (Platform.OS === 'ios' && ChatBrowser != null) {
    await ChatBrowser.open(url)
    return
  }
  if (
    Platform.OS === 'android' &&
    typeof NativeModules.TSExternalBrowser?.openChatLink === 'function'
  )
    return await NativeModules.TSExternalBrowser.openChatLink(url)
  throw new Error('Chat browser unavailable')
}
