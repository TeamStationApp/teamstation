import {
  type DocumentPickerResponse,
  keepLocalCopy,
  pick
} from '@react-native-documents/picker'
import { Platform } from 'react-native'
import ReactNativeBlobUtil from 'react-native-blob-util'
import { launchImageLibrary } from 'react-native-image-picker'
import { fromByteArray, toByteArray } from 'react-native-quick-base64'

import {
  contentTypeOf,
  type PickedFile,
  type PickSource,
  safeFileName
} from './chatFileTypes'

/**
 * Attachments on a phone: photos and videos from the library through
 * `react-native-image-picker`, any file through `@react-native-documents/
 * picker`, and bytes read and written through `react-native-blob-util`.
 * Opened bytes are written to the app's cache to be shown, played or
 * shared, and deleted when the screen lets them go. The web's twin is
 * `chatFiles.ts`.
 */

export const PICK_SOURCES: PickSource[] = ['photos', 'files']

const pathOf = (uri: string): string =>
  decodeURIComponent(uri.replace(/^file:\/\//, ''))

/** A local file's bytes. */
async function readBytes(uri: string): Promise<Uint8Array> {
  const base64 = (await ReactNativeBlobUtil.fs.readFile(
    pathOf(uri),
    'base64'
  )) as string
  return toByteArray(base64)
}

async function fromLibrary(): Promise<PickedFile[]> {
  // One at a time: a tap on a photo picks it at once, and Attach again
  // adds another.
  const answer = await launchImageLibrary({
    mediaType: 'mixed',
    selectionLimit: 1
  })
  if (answer.didCancel === true || answer.assets == null) return []
  if (answer.errorCode != null) {
    throw new Error(answer.errorMessage ?? answer.errorCode)
  }
  const picked: PickedFile[] = []
  for (const asset of answer.assets) {
    if (asset.uri == null) continue
    const fileName = asset.fileName ?? 'photo'
    picked.push({
      bytes: await readBytes(asset.uri),
      contentType: contentTypeOf(fileName, asset.type),
      fileName,
      ...(asset.width == null ? {} : { width: asset.width }),
      ...(asset.height == null ? {} : { height: asset.height }),
      ...(asset.duration == null
        ? {}
        : { durationMs: Math.round(asset.duration * 1000) })
    })
  }
  return picked
}

async function fromFiles(): Promise<PickedFile[]> {
  let documents: DocumentPickerResponse[]
  try {
    documents = await pick({ allowMultiSelection: true })
  } catch (error) {
    // Cancelling the picker is an answer of nothing, not a failure.
    if ((error as { code?: string }).code === 'OPERATION_CANCELED') return []
    throw error
  }
  const picked: PickedFile[] = []
  for (const document of documents) {
    const fileName = document.name ?? 'file'
    const [copy] = await keepLocalCopy({
      files: [{ uri: document.uri, fileName: safeFileName(fileName) }],
      destination: 'cachesDirectory'
    })
    if (copy.status !== 'success') throw new Error(copy.copyError)
    picked.push({
      bytes: await readBytes(copy.localUri),
      contentType: contentTypeOf(fileName, document.type),
      fileName
    })
    await ReactNativeBlobUtil.fs.unlink(pathOf(copy.localUri)).catch(() => {})
  }
  return picked
}

/** Opens the photo library or the file picker; nothing on Cancel. */
export async function pickFiles(source: PickSource): Promise<PickedFile[]> {
  return source === 'photos' ? await fromLibrary() : await fromFiles()
}

let written = 0

/** Writes opened bytes to the cache and answers its `file://` URL. */
export async function bytesUri(
  bytes: Uint8Array,
  _contentType: string,
  fileName: string
): Promise<string> {
  written += 1
  const path = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/chat-${Date.now()}-${written}-${safeFileName(fileName)}`
  await ReactNativeBlobUtil.fs.writeFile(path, fromByteArray(bytes), 'base64')
  return `file://${path}`
}

/** Deletes a file `bytesUri` wrote. */
export async function releaseUri(uri: string): Promise<void> {
  if (!uri.startsWith('file://')) return
  await ReactNativeBlobUtil.fs.unlink(pathOf(uri)).catch(() => {})
}

/**
 * Offers opened bytes to the system: the share sheet on iOS (Save to
 * Files, AirDrop, Mail), and an app that opens the type on Android.
 */
export async function saveFile(
  bytes: Uint8Array,
  contentType: string,
  fileName: string
): Promise<void> {
  const path = pathOf(await bytesUri(bytes, contentType, fileName))
  if (Platform.OS === 'ios') {
    ReactNativeBlobUtil.ios.presentOptionsMenu(path)
    return
  }
  await ReactNativeBlobUtil.android.actionViewIntent(path, contentType)
}
