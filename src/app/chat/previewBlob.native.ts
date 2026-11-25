import { nativePreviewRead } from './previewNativeRead'

/**
 * Reads through the same public-address-only reader as outgoing previews,
 * so storage on localhost or a LAN address (a local dev server) leaves
 * received cards' thumbnails empty on phones; other attachments still load.
 */
export async function readPreviewBlob(
  url: string,
  size: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const bytes = await nativePreviewRead(url, 2, size, signal)
  if (bytes.length !== size) throw Error('Incomplete thumbnail')
  return bytes
}
