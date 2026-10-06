import type { OutgoingFile } from './engine/send'

/**
 * What the two attachment twins (`chatFiles.ts` for the web,
 * `chatFiles.native.ts` for the phones) share: the shape of a picked file
 * and where one can be picked from. Neither twin may import the other.
 */

/** Where the composer's Attach offers to pick from. */
export type PickSource = 'photos' | 'files'

/** A picked file, its bytes read, ready for `engine.attach`. */
export type PickedFile = OutgoingFile

/** A file's name with nothing in it a file system would refuse. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  return cleaned === '' ? 'file' : cleaned.slice(-120)
}

/** A content type for a name with none given. */
export function contentTypeOf(name: string, given?: string | null): string {
  if (given != null && given !== '') return given
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'heic':
      return 'image/heic'
    case 'mp4':
      return 'video/mp4'
    case 'mov':
      return 'video/quicktime'
    case 'pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}
