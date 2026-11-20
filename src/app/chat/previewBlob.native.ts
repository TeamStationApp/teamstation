import { nativePreviewRead } from './previewNativeRead'

export async function readPreviewBlob(
  url: string,
  size: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const bytes = await nativePreviewRead(url, 2, size, signal)
  if (bytes.length !== size) throw Error('Incomplete thumbnail')
  return bytes
}
