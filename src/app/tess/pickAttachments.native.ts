import { pick } from '@react-native-documents/picker'
import { Platform } from 'react-native'
import { launchImageLibrary } from 'react-native-image-picker'
import { base64 } from 'rfc4648'

import {
  chooseNativeAttachment,
  type NativeAttachChoice
} from './nativeAttachments'
import type { TessUpload } from './tessTypes'

/** A picked file's bytes: the app's own fetch reads `file:` and `content:` addresses. */
export async function readPickedFile(uri: string): Promise<string> {
  const response = await fetch(uri)
  return base64.stringify(new Uint8Array(await response.arrayBuffer()))
}

/** The + sheet's Photo and File, with the real pickers. */
export async function pickNativeAttachment(
  choice: NativeAttachChoice
): Promise<TessUpload | null> {
  return await chooseNativeAttachment(choice, {
    os: Platform.OS === 'ios' ? 'ios' : 'android',
    launchImageLibrary,
    pickDocument: async options => await pick(options),
    readFile: readPickedFile
  })
}
