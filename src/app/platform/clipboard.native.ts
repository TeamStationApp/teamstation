import Clipboard from '@react-native-clipboard/clipboard'

/**
 * Copy, where this app runs.
 *
 * Always available on a phone, and synchronous, which is why this side has no
 * failure to swallow.
 */
export function copyToClipboard(text: string): void {
  Clipboard.setString(text)
}
