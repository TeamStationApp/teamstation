import { lstrings, sprintf } from '../locales/strings'
import type { TessAttachmentKind } from './tessTypes'

/** What the browser's chooser offers: the types Tess reads, by type and name. */
export const TESS_ACCEPT =
  'image/*,.csv,.txt,.md,text/csv,text/plain,text/markdown'

const TYPES: Record<string, TessAttachmentKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'text/csv': 'csv',
  'text/plain': 'text',
  'text/markdown': 'markdown'
}

/** Other names the same types travel under. */
const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'text/comma-separated-values': 'text/csv',
  'text/x-markdown': 'text/markdown'
}

const EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown'
}

/** The server's limits, in decoded bytes. */
export const IMAGE_LIMIT = 5 * 1024 * 1024
export const TEXT_LIMIT = 1024 * 1024

/**
 * The type a file is sent as, from what the platform says it is or, when that
 * is missing or unhelpful (a CSV that Windows calls a spreadsheet), from its
 * name. Null for a file Tess cannot read.
 */
export function uploadTypeOf(
  name: string,
  type: string | null | undefined
): { mediaType: string; kind: TessAttachmentKind } | null {
  const given = (type ?? '').toLowerCase().split(';')[0].trim()
  const known = ALIASES[given] ?? given
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase()
  const mediaType =
    TYPES[known] != null
      ? known
      : extension == null
        ? undefined
        : EXTENSIONS[extension]
  if (mediaType == null) return null
  return { mediaType, kind: TYPES[mediaType] }
}

/** The bytes a base64 string holds. */
export function decodedSize(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** Refuses a file over its kind's limit before it is sent. */
export function checkUploadSize(
  name: string,
  kind: TessAttachmentKind,
  bytes: number
): void {
  if (bytes > (kind === 'image' ? IMAGE_LIMIT : TEXT_LIMIT))
    throw new Error(sprintf(lstrings.tess_attach_too_large, name))
}
