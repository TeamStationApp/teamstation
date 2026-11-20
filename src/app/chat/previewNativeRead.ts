import { base64 } from 'rfc4648'

import ChatPreview from './NativeChatPreview'

// Both native boundaries admit two reads. Prefer a live composer over
// queued conversation images when one of those workers becomes available.
let active = 0
const composerQueue = new Set<() => void>()
const thumbnailQueue = new Set<() => void>()
let nextId = 0
export async function nativePreviewRead(
  url: string,
  kind: number,
  limit: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const module = ChatPreview
  if (module == null || signal?.aborted === true)
    throw Error('Preview unavailable')
  if (active < 2) active++
  else {
    const queue = kind === 2 ? thumbnailQueue : composerQueue
    await new Promise<void>((resolve, reject) => {
      const start = (): void => {
        queue.delete(start)
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = (): void => {
        queue.delete(start)
        reject(Error('Preview unavailable'))
      }
      queue.add(start)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  nextId = (nextId + 1) % 2147483647
  const id = nextId
  const cancel = (): void => {
    module.cancel(id)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted ?? false) throw Error('Preview unavailable')
    const data = await module.read(id, url, kind, limit)
    if (data === '' || data.length > 4 * Math.ceil(limit / 3))
      throw Error('Preview unavailable')
    const bytes = base64.parse(data)
    if (bytes.length > limit || (signal?.aborted ?? false))
      throw Error('Preview unavailable')
    return bytes
  } finally {
    signal?.removeEventListener('abort', cancel)
    const next =
      composerQueue.values().next().value ??
      thumbnailQueue.values().next().value
    if (next == null) active--
    else next()
  }
}
