import { Linking, NativeModules, Platform } from 'react-native'

interface BrowserModule {
  open: (url: string) => Promise<void>
}

export async function openExternal(url: string): Promise<void> {
  if (Platform.OS === 'android') {
    const browser = NativeModules.TSExternalBrowser as BrowserModule | undefined
    if (browser == null) throw new Error('An external browser is not available')
    await browser.open(url)
  } else await Linking.openURL(url)
}
export const resumeBrowser = openExternal
export const nativeBrowser = true
