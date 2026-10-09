import { MAX_ATTACHMENTS } from '../../common/chatContent'
import { attachmentProblem } from './chatComposeModel'
import {
  contentTypeOf,
  type PickedFile,
  type PickSource
} from './chatFileTypes'

/**
 * Attachments in a browser: picking through an `<input type="file">`, and
 * opened bytes shown, played or saved through a `Blob` and its URL. The
 * phones' twin is `chatFiles.native.ts`.
 */

/** A browser has one picker; it shows photos and files alike. */
export const PICK_SOURCES: PickSource[] = ['files']

/** The pixel size of an image's bytes, where the browser can tell. */
async function imageSize(
  file: Blob
): Promise<{ width: number; height: number } | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return undefined
  }
}

/** How long a video's size and length are waited for before going on. */
export const VIDEO_META_MS = 3000

/** A video's pixel size and length, where the browser can read them. */
async function videoMeta(
  file: Blob,
  waitMs: number
): Promise<{ width: number; height: number; durationMs: number } | undefined> {
  const doc = typeof document === 'undefined' ? undefined : document
  if (doc == null || typeof URL.createObjectURL !== 'function') return undefined
  const url = URL.createObjectURL(file)
  const video = doc.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  try {
    return await new Promise(resolve => {
      const timer = setTimeout(() => {
        resolve(undefined)
      }, waitMs)
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(timer)
        resolve(
          video.videoWidth > 0
            ? {
                width: video.videoWidth,
                height: video.videoHeight,
                durationMs: Number.isFinite(video.duration)
                  ? Math.round(video.duration * 1000)
                  : 0
              }
            : undefined
        )
      })
      video.addEventListener('error', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
      video.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Reads the files an input was given, as the engine sends them. */
export async function readPicked(
  files: Iterable<File>,
  waitMs = VIDEO_META_MS,
  remaining = MAX_ATTACHMENTS
): Promise<PickedFile[]> {
  const chosen = Array.from(files)
  const problem = attachmentProblem(
    chosen.map(file => ({ fileName: file.name, size: file.size })),
    remaining
  )
  if (problem != null) throw new Error(problem)
  const picked: PickedFile[] = []
  for (const file of chosen) {
    const contentType = contentTypeOf(file.name, file.type)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const size = contentType.startsWith('image/')
      ? await imageSize(file)
      : contentType.startsWith('video/')
        ? await videoMeta(file, waitMs)
        : undefined
    picked.push({
      bytes,
      contentType,
      fileName: file.name,
      ...(size ?? {})
    })
  }
  return picked
}

/**
 * Opens the browser's file picker and answers what was picked (nothing on
 * Cancel, which a browser reports only by never firing `change`, so the
 * answer then simply never comes — the composer does not wait on it).
 */
export async function pickFiles(
  _source: PickSource,
  docOrRemaining: Document | number = document,
  remaining = MAX_ATTACHMENTS
): Promise<PickedFile[]> {
  const doc = typeof docOrRemaining === 'number' ? document : docOrRemaining
  if (typeof docOrRemaining === 'number') remaining = docOrRemaining
  const input = doc.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.style.display = 'none'
  doc.body.appendChild(input)
  try {
    const files = await new Promise<File[]>(resolve => {
      input.addEventListener('change', () => {
        resolve(Array.from(input.files ?? []))
      })
      input.addEventListener('cancel', () => {
        resolve([])
      })
      input.click()
    })
    return await readPicked(files, undefined, remaining)
  } finally {
    input.remove()
  }
}

/** A URL the page can show or play opened bytes from. */
export async function bytesUri(
  bytes: Uint8Array,
  contentType: string,
  _fileName: string
): Promise<string> {
  return URL.createObjectURL(new Blob([bytes], { type: contentType }))
}

/** Lets a URL from `bytesUri` go. */
export async function releaseUri(uri: string): Promise<void> {
  if (uri.startsWith('blob:')) URL.revokeObjectURL(uri)
}

/** Saves opened bytes as a download with the file's own name. */
export async function saveFile(
  bytes: Uint8Array,
  contentType: string,
  fileName: string,
  doc: Document = document
): Promise<void> {
  const url = await bytesUri(bytes, contentType, fileName)
  const link = doc.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  doc.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 60000)
}
