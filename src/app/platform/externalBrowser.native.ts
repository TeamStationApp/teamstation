import { Linking } from 'react-native'

export async function openExternal(url: string): Promise<void> {
  await Linking.openURL(url)
}
export const resumeBrowser = openExternal
export const nativeBrowser = true
