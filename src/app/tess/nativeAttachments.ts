import type {
  DocumentPickerOptions,
  DocumentPickerResponse
} from '@react-native-documents/picker'
import type {
  ImageLibraryOptions,
  ImagePickerResponse
} from 'react-native-image-picker'

import { lstrings } from '../locales/strings'
import type { TessUpload } from './tessTypes'
import { checkUploadSize, decodedSize, uploadTypeOf } from './tessUploads'

export type NativeAttachChoice = 'photo' | 'file'

/**
 * The document types the File picker offers: CSV, plain text and Markdown.
 * iOS names them by uniform type, Android by MIME type.
 */
export const DOCUMENT_TYPES = {
  ios: [
    'public.comma-separated-values-text',
    'public.plain-text',
    'net.daringfireball.markdown'
  ],
  android: [
    'text/csv',
    'text/comma-separated-values',
    'text/plain',
    'text/markdown',
    'text/x-markdown'
  ]
}

/** The pickers and the file reader, passed in so Node can stand in for them. */
export interface NativePickers {
  os: 'ios' | 'android'
  launchImageLibrary: (
    options: ImageLibraryOptions
  ) => Promise<ImagePickerResponse>
  pickDocument: (
    options: DocumentPickerOptions
  ) => Promise<DocumentPickerResponse[]>
  /** A picked file's bytes, as base64. */
  readFile: (uri: string) => Promise<string>
}

/**
 * Runs the picker the user chose from the + sheet and answers the file ready
 * to upload, or null when they cancelled. A file Tess cannot read, one too
 * large to send, or one that cannot be read throws with the reason to show.
 */
export async function chooseNativeAttachment(
  choice: NativeAttachChoice,
  pickers: NativePickers
): Promise<TessUpload | null> {
  return choice === 'photo'
    ? await choosePhoto(pickers)
    : await chooseDocument(pickers)
}

async function choosePhoto(pickers: NativePickers): Promise<TessUpload | null> {
  const result = await pickers.launchImageLibrary({
    mediaType: 'photo',
    selectionLimit: 1,
    includeBase64: true,
    maxWidth: 2048,
    maxHeight: 2048,
    quality: 0.9
  })
  if (result.didCancel === true) return null
  if (result.errorCode != null) throw new Error(lstrings.tess_attach_failed)
  const asset = result.assets?.[0]
  if (asset?.base64 == null) throw new Error(lstrings.tess_attach_unreadable)
  const name = asset.fileName ?? 'photo'
  const type = uploadTypeOf(name, asset.type)
  if (type?.kind !== 'image') throw new Error(lstrings.tess_attach_unsupported)
  checkUploadSize(name, type.kind, decodedSize(asset.base64))
  return { name, mediaType: type.mediaType, data: asset.base64 }
}

async function chooseDocument(
  pickers: NativePickers
): Promise<TessUpload | null> {
  let picked: DocumentPickerResponse[]
  try {
    picked = await pickers.pickDocument({
      type: DOCUMENT_TYPES[pickers.os],
      allowMultiSelection: false,
      mode: 'import'
    })
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'OPERATION_CANCELED')
      return null
    throw new Error(lstrings.tess_attach_failed)
  }
  const file = picked[0]
  if (file == null) return null
  if (file.error != null) throw new Error(lstrings.tess_attach_unreadable)
  const name = file.name ?? 'file.txt'
  const type = uploadTypeOf(name, file.type)
  if (type == null || type.kind === 'image')
    throw new Error(lstrings.tess_attach_unsupported)
  if (file.size != null) checkUploadSize(name, type.kind, file.size)
  let data: string
  try {
    data = await pickers.readFile(file.uri)
  } catch {
    throw new Error(lstrings.tess_attach_unreadable)
  }
  checkUploadSize(name, type.kind, decodedSize(data))
  return { name, mediaType: type.mediaType, data }
}
