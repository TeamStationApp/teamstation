import { NativeModules, Platform } from 'react-native'

import { appOrigin } from '../native/config'
import { CacheUrl } from '../sync/cacheUrl'
import { whileChatBrowserOpen } from './chatBrowserVisibility'
import ChatBrowser from './NativeChatBrowser'

export function chatLinkOrigins(apiBaseUrl: string): {
  active?: string
  verified?: string
} {
  try {
    return { active: new CacheUrl(apiBaseUrl).origin, verified: appOrigin }
  } catch {
    return { verified: appOrigin }
  }
}

export async function openChatBrowser(url: string): Promise<void> {
  const safari = ChatBrowser
  if (Platform.OS === 'ios' && safari != null) {
    await whileChatBrowserOpen(async () => {
      await safari.open(url)
    })
    return
  }
  if (
    Platform.OS === 'android' &&
    typeof NativeModules.TSExternalBrowser?.openChatLink === 'function'
  )
    return await NativeModules.TSExternalBrowser.openChatLink(url)
  throw new Error('Chat browser unavailable')
}
