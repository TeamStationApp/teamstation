import {
  type DocumentPickerResponse,
  keepLocalCopy,
  pick
} from '@react-native-documents/picker'
import { PermissionsAndroid, Platform } from 'react-native'
import ReactNativeBlobUtil from 'react-native-blob-util'
import {
  type ImagePickerResponse,
  launchCamera,
  launchImageLibrary
} from 'react-native-image-picker'
import { fromByteArray, toByteArray } from 'react-native-quick-base64'

import { MAX_ATTACHMENTS } from '../../common/chatContent'
import { lstrings } from '../locales/strings'
import { attachmentProblem } from './chatComposeModel'
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

export const PICK_SOURCES: PickSource[] = ['photos', 'camera', 'files']

const pathOf = (uri: string): string =>
  decodeURIComponent(uri.replace(/^file:\/\//, ''))

/** A local file's bytes. */
async function readBytes(uri: string, fileName: string): Promise<Uint8Array> {
  const size = Number((await ReactNativeBlobUtil.fs.stat(pathOf(uri))).size)
  if (!Number.isFinite(size) || size < 0)
    throw new Error('File size unavailable')
  const problem = attachmentProblem([{ fileName, size }])
  if (problem != null) throw new Error(problem)
  const base64 = (await ReactNativeBlobUtil.fs.readFile(
    pathOf(uri),
    'base64'
  )) as string
  return toByteArray(base64)
}

async function pickedMedia(
  answer: ImagePickerResponse,
  remaining: number
): Promise<PickedFile[]> {
  if (answer.didCancel === true) return []
  if (answer.errorCode != null)
    throw new Error(answer.errorMessage ?? answer.errorCode)
  if (answer.assets == null) return []
  const problem = attachmentProblem(
    answer.assets
      .filter(asset => asset.uri != null)
      .map(asset => ({
        fileName: asset.fileName ?? 'photo',
        size: asset.fileSize ?? 0
      })),
    remaining
  )
  if (problem != null) throw new Error(problem)
  const picked: PickedFile[] = []
  for (const asset of answer.assets) {
    if (asset.uri == null) continue
    if (asset.uri.trim() === '')
      throw new Error(lstrings.chat_attachment_failed)
    const fileName = asset.fileName ?? 'photo'
    picked.push({
      bytes: await readBytes(asset.uri, fileName),
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

async function fromFiles(remaining: number): Promise<PickedFile[]> {
  let documents: DocumentPickerResponse[]
  try {
    documents = await pick({ allowMultiSelection: false })
  } catch (error) {
    // Cancelling the picker is an answer of nothing, not a failure.
    if ((error as { code?: string }).code === 'OPERATION_CANCELED') return []
    throw error
  }
  const problem = attachmentProblem(
    documents.map(document => ({
      fileName: document.name ?? 'file',
      size: document.size ?? 0
    })),
    remaining
  )
  if (problem != null) throw new Error(problem)
  const picked: PickedFile[] = []
  for (const document of documents) {
    const fileName = document.name ?? 'file'
    const [copy] = await keepLocalCopy({
      files: [{ uri: document.uri, fileName: safeFileName(fileName) }],
      destination: 'cachesDirectory'
    })
    if (copy.status !== 'success') throw new Error(copy.copyError)
    try {
      picked.push({
        bytes: await readBytes(copy.localUri, fileName),
        contentType: contentTypeOf(fileName, document.type),
        fileName
      })
    } finally {
      await ReactNativeBlobUtil.fs.unlink(pathOf(copy.localUri)).catch(() => {})
    }
  }
  return picked
}

/** Opens Photos, Camera or File and returns an empty list on cancellation. */
export async function pickFiles(
  source: PickSource,
  remaining = MAX_ATTACHMENTS
): Promise<PickedFile[]> {
  if (source === 'files') return await fromFiles(remaining)
  if (source === 'photos') {
    const result = await launchImageLibrary({
      mediaType: 'mixed',
      selectionLimit: 1
    })
    return await pickedMedia(result, remaining)
  }
  if (Platform.OS === 'android') {
    const permission = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.CAMERA
    )
    if (permission !== PermissionsAndroid.RESULTS.GRANTED)
      throw new Error(lstrings.chat_camera_permission)
  }
  const result = await launchCamera({ mediaType: 'photo', saveToPhotos: false })
  if (result.errorCode === 'permission')
    throw new Error(lstrings.chat_camera_permission)
  if (result.errorCode === 'camera_unavailable')
    throw new Error(lstrings.chat_camera_unavailable)
  const captured = await pickedMedia(result, remaining)
  if (
    result.didCancel !== true &&
    (captured.length !== 1 || captured[0].bytes.length === 0)
  )
    throw new Error(lstrings.chat_attachment_failed)
  return captured
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
