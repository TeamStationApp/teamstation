import { MAX_THUMBNAIL_BYTES } from '../../common/chatLinkPreview'
import type { OutgoingFile } from './engine/send'
import {
  MAX_HTML_BYTES,
  MAX_IMAGE_BYTES,
  previewDestination
} from './linkPreview'
import { rasterDimensions } from './previewImage'

async function frameBytes(
  url: string,
  kind: 'html' | 'image',
  signal: AbortSignal
): Promise<{ bytes: Uint8Array; mime: string }> {
  return await new Promise((resolve, reject) => {
    if (signal.aborted || previewDestination(url, location.origin) !== url) {
      reject(Error('Unavailable preview'))
      return
    }
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.sandbox.add('allow-scripts')
    frame.referrerPolicy = 'no-referrer'
    frame.allow =
      "local-network-access 'none'; local-network 'none'; loopback-network 'none'"
    frame.src = '/chat-link-preview.html'
    const channel = new MessageChannel()
    const id = crypto.randomUUID()
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort)
      frame.remove()
      channel.port1.close()
      channel.port2.close()
    }
    const abort = (): void => {
      channel.port1.postMessage({ cancel: true })
      cleanup()
      reject(Error('Unavailable preview'))
    }
    signal.addEventListener('abort', abort, { once: true })
    channel.port1.onmessage = ({ data }) => {
      if (
        data?.id !== id ||
        !(data.bytes instanceof ArrayBuffer) ||
        typeof data.mime !== 'string' ||
        data.bytes.byteLength >
          (kind === 'html' ? MAX_HTML_BYTES : MAX_IMAGE_BYTES)
      ) {
        abort()
        return
      }
      cleanup()
      resolve({ bytes: new Uint8Array(data.bytes), mime: data.mime })
    }
    frame.onerror = abort
    frame.onload = () =>
      frame.contentWindow?.postMessage(
        { type: 'read-preview', id, url, kind },
        '*',
        [channel.port2]
      )
    document.body.appendChild(frame)
  })
}

export async function readPreviewPage(
  url: string,
  signal: AbortSignal
): Promise<string> {
  const { bytes, mime } = await frameBytes(url, 'html', signal)
  const charset = /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(mime)
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset?.[1] ?? charset?.[2])
  } catch {
    decoder = new TextDecoder()
  }
  return decoder.decode(bytes)
}

export async function previewThumbnail(
  url: string,
  signal: AbortSignal
): Promise<OutgoingFile | undefined> {
  const { bytes, mime } = await frameBytes(url, 'image', signal)
  const shape = rasterDimensions(bytes)
  if (shape?.mime !== mime || signal.aborted) return
  const bitmap = await createImageBitmap(
    new Blob([new Uint8Array(bytes)], { type: shape.mime })
  )
  try {
    if (signal.aborted || bitmap.width * bitmap.height > 12_000_000) return
    const factor = Math.min(1, 480 / bitmap.width, 320 / bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * factor))
    canvas.height = Math.max(1, Math.round(bitmap.height * factor))
    const ctx = canvas.getContext('2d')
    if (ctx == null) return
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.76)
    })
    if (blob == null || blob.size > MAX_THUMBNAIL_BYTES || signal.aborted)
      return
    return {
      fileName: 'preview.jpg',
      contentType: 'image/jpeg',
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width,
      height: canvas.height
    }
  } finally {
    bitmap.close()
  }
}
