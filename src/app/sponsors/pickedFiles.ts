// A file the administrator dropped or chose, as the sponsor screens hold it:
// its name, type and size, and an object URL the preview and the row show.
import type { PickedFile } from './sponsorTypes'

/** The browser's object URLs, which a test stands in for. */
export interface ObjectUrls {
  createObjectURL: (file: Blob) => string
}

/**
 * The files behind the object URLs this page made, so shrinking reads a
 * picked file's bytes without fetching its `blob:` URL, which the page's
 * `connect-src` does not allow.
 */
const picked = new Map<string, Blob>()

/** The file an object URL was made for, if this page made it. */
export function blobOf(url: string): Blob | undefined {
  return picked.get(url)
}

/** `file` as a `PickedFile`, with an object URL for it. */
export function pickedFileOf(file: File, urls: ObjectUrls = URL): PickedFile {
  const url = urls.createObjectURL(file)
  picked.set(url, file)
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    url
  }
}

/** How long a video's length is waited for before the file is given up on. */
export const DURATION_TIMEOUT_MS = 10_000

/**
 * The length of the video at `picked`, in seconds, read from its metadata
 * by a detached `<video>`. Rejects when the browser cannot read it, or has
 * not within `timeoutMs`.
 */
export async function readVideoDuration(
  picked: Pick<PickedFile, 'url'>,
  {
    timeoutMs = DURATION_TIMEOUT_MS,
    createVideo = () => document.createElement('video')
  }: {
    timeoutMs?: number
    createVideo?: () => HTMLVideoElement
  } = {}
): Promise<number> {
  const video = createVideo()
  return await new Promise<number>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', loaded)
      video.removeEventListener('error', failed)
      video.removeAttribute('src')
    }
    const loaded = (): void => {
      const duration = video.duration
      done()
      resolve(duration)
    }
    const failed = (): void => {
      done()
      reject(new Error('This video could not be read. Try another file.'))
    }
    const timer = setTimeout(failed, timeoutMs)
    video.addEventListener('loadedmetadata', loaded)
    video.addEventListener('error', failed)
    video.preload = 'metadata'
    video.muted = true
    video.src = picked.url
  })
}
