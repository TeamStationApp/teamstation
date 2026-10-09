import Clipboard from '@react-native-clipboard/clipboard'

export async function copyChatText(text: string): Promise<void> {
  Clipboard.setString(text)
}
