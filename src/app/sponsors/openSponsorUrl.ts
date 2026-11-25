import { Linking, Platform } from 'react-native'

/**
 * Opens a sponsored row's website: a new tab on the web, the phone's
 * browser in the apps. Only an https address opens, as the rows' rules
 * allow no other.
 */
export function openSponsorUrl(
  url: string,
  {
    os = Platform.OS,
    open = (address: string) => {
      // The browser's window; a phone has none and never takes this path.
      ;(
        globalThis as {
          window?: {
            open: (url: string, target: string, features: string) => unknown
          }
        }
      ).window?.open(address, '_blank', 'noopener')
    },
    openURL = async (address: string) => {
      await Linking.openURL(address)
    }
  }: {
    os?: string
    open?: (url: string) => void
    openURL?: (url: string) => Promise<void>
  } = {}
): void {
  if (!url.startsWith('https://')) return
  if (os === 'web') open(url)
  else openURL(url).catch(() => undefined)
}
