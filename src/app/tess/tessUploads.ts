import { TESS_MAX_IMAGE_BYTES, TESS_MAX_TEXT_BYTES } from '../../common/api'
import { lstrings, sprintf } from '../locales/strings'
import type { TessAttachmentKind } from './tessTypes'

/**
 * Checks on a file before it is sent to Tess. Which files she reads, and how
 * large, are the server's rules, kept with the API in `common/api`
 * (`tessUploadType`, `TESS_MAX_IMAGE_BYTES`, `TESS_MAX_TEXT_BYTES`).
 */

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
  if (bytes > (kind === 'image' ? TESS_MAX_IMAGE_BYTES : TESS_MAX_TEXT_BYTES))
    throw new Error(sprintf(lstrings.tess_attach_too_large, name))
}

/** Why a file could not be attached, in words. */
export function attachFailure(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : lstrings.tess_attach_unreadable
}
