import { fromUtf8 } from '../../common/chatCrypto/bytes'
import { MAX_THUMBNAIL_BYTES } from '../../common/chatLinkPreview'
import type { OutgoingFile } from './engine/send'
import { MAX_HTML_BYTES } from './linkPreview'
import { rasterDimensions } from './previewImage'
import { nativePreviewRead } from './previewNativeRead'

export async function readPreviewPage(
  url: string,
  signal: AbortSignal
): Promise<string> {
  return fromUtf8(await nativePreviewRead(url, 0, MAX_HTML_BYTES, signal))
}
export async function previewThumbnail(
  url: string,
  signal: AbortSignal
): Promise<OutgoingFile | undefined> {
  const bytes = await nativePreviewRead(url, 1, MAX_THUMBNAIL_BYTES, signal)
  const shape = rasterDimensions(bytes)
  if (shape?.mime !== 'image/jpeg' || shape.width > 480 || shape.height > 320)
    return
  return {
    fileName: 'preview.jpg',
    contentType: shape.mime,
    width: shape.width,
    height: shape.height,
    bytes
  }
}
