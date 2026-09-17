import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { presignGetUrl } from './presign'
import { spaceConfigured, type SpaceSettings } from './spacesHls'

const run = promisify(execFile)

/**
 * A team's mark, a league's mark, a person's face.
 *
 * An import hands these out as short-lived presigned URLs, so a picture is
 * fetched and stored at once or not at all — nothing is ever kept as a link
 * back to them. What lands in the Space is a normalised copy at two fixed
 * sizes, named by a hash of its own bytes, so re-running an import uploads
 * nothing unless the picture itself changed.
 *
 * FFmpeg does the normalising rather than an image library, because the
 * pinned build is already here, already version-checked, and already the one
 * thing allowed to touch media.
 */

/** What a picture belongs to. The `users` case is the one holding faces. */
export type ImageKind = 'team' | 'league' | 'user'

/**
 * The sizes stored, smallest first: a list tile and a profile.
 *
 * 192 is not a design choice, it is the import source's: every avatar it
 * serves is 192 square. Storing a larger one would be an upscale pretending to
 * be a photograph.
 */
export const IMAGE_SIZES = [96, 192] as const
export type ImageSize = (typeof IMAGE_SIZES)[number]

/** The most a picture may weigh before we refuse to believe it is one. */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024

export interface NormalisedImage {
  /** SHA-256 of the largest rendition, which is what the key is named for. */
  sha256: string
  /** The rendered bytes, by size. */
  bySize: Map<ImageSize, Buffer>
}

/**
 * The key prefix a row stores: the size and extension are appended on read.
 *
 * Named by entity id rather than by date or source, for the reason video
 * directories are: the id is the only part that cannot change.
 */
export function imagePathPrefix(
  kind: ImageKind,
  entityId: string,
  sha256: string
): string {
  return `images/${kind}/${entityId}/${sha256.slice(0, 8)}`
}

/** `images/user/usr_1/1f4c2a90-96.png`. */
export function imageKey(prefix: string, size: ImageSize): string {
  return `${prefix}-${size}.png`
}

/**
 * Square, centre-cropped, at both sizes, as PNG.
 *
 * A face is cropped rather than letterboxed: a tile with bars down the sides
 * looks broken in a list where its neighbours fill their circles. A mark is
 * contained instead, because cropping a badge cuts the club's name off.
 */
export async function normaliseImage(options: {
  ffmpegPath: string
  source: Buffer
  kind: ImageKind
}): Promise<NormalisedImage> {
  const { ffmpegPath, source, kind } = options
  if (source.length === 0) throw new Error('Empty image')
  if (source.length > MAX_SOURCE_BYTES) {
    throw new Error(`Image is ${source.length} bytes, which is not a picture`)
  }

  const dir = await mkdtemp(join(tmpdir(), 'gsImage-'))
  try {
    const input = join(dir, 'in')
    await writeFile(input, source)

    const bySize = new Map<ImageSize, Buffer>()
    for (const size of IMAGE_SIZES) {
      const output = join(dir, `${size}.png`)
      await run(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          filterFor(kind, size),
          output
        ],
        { maxBuffer: 1 << 22 }
      )
      const bytes = await readFile(output)
      if (bytes.length === 0) throw new Error('FFmpeg produced no image')
      bySize.set(size, bytes)
    }

    const largest = bySize.get(IMAGE_SIZES[IMAGE_SIZES.length - 1])
    if (largest == null) throw new Error('No rendition was produced')
    return { sha256: sha256Of(largest), bySize }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function filterFor(kind: ImageKind, size: ImageSize): string {
  if (kind === 'user') {
    // Fill the square and cut the overflow: `increase` then a centred crop.
    return `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`
  }
  // Fit inside the square and pad the rest with nothing, so a wide badge keeps
  // its proportions and a transparent PNG stays transparent.
  return (
    `scale=${size}:${size}:force_original_aspect_ratio=decrease,` +
    `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=#00000000`
  )
}

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Fetches a picture from wherever it is, with a deadline.
 *
 * Those URLs carry their own expiry, so a slow or hanging fetch is not
 * worth waiting on: by the time it finished the signature could be stale
 * anyway.
 */
export async function fetchImage(
  url: string,
  timeoutMs = 15000
): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new Error(`Image fetch answered ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Writes one object into the Space with a presigned PUT.
 *
 * The same signing as reading, with the verb changed, so there is no SDK and
 * no second implementation of SigV4 to keep in step.
 */
export async function putObject(options: {
  space: SpaceSettings
  key: string
  body: Buffer
  contentType: string
}): Promise<void> {
  const { space, key, body, contentType } = options
  if (!spaceConfigured(space)) throw new Error('No Space is configured')

  const url = presignGetUrl({
    method: 'PUT',
    endpoint: space.endpoint,
    region: space.region,
    bucket: space.bucket,
    accessKeyId: space.accessKeyId,
    secretAccessKey: space.secretAccessKey,
    key,
    expiresSec: 300,
    pathStyle: space.pathStyle
  })

  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: { 'content-type': contentType }
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Upload of ${key} answered ${response.status} ${detail.slice(0, 200)}`
    )
  }
}

export interface StoredImage {
  /** What goes in `logo_path` / `avatar_path`. */
  pathPrefix: string
  sha256: string
  bytesUploaded: number
}

/**
 * Normalise, hash, and upload — unless the hash says we already have it.
 *
 * `knownSha256` is the value already on the row. When it matches, nothing is
 * uploaded and nothing is written: an import that runs nightly should cost
 * one fetch per picture and no writes at all.
 */
export async function storeImage(options: {
  ffmpegPath: string
  space: SpaceSettings
  kind: ImageKind
  entityId: string
  source: Buffer
  knownSha256?: string | null
}): Promise<StoredImage | undefined> {
  const { ffmpegPath, space, kind, entityId, source, knownSha256 } = options

  const image = await normaliseImage({ ffmpegPath, source, kind })
  if (knownSha256 != null && knownSha256 === image.sha256) return undefined

  const pathPrefix = imagePathPrefix(kind, entityId, image.sha256)
  let bytesUploaded = 0
  for (const [size, bytes] of image.bySize) {
    await putObject({
      space,
      key: imageKey(pathPrefix, size),
      body: bytes,
      contentType: 'image/png'
    })
    bytesUploaded += bytes.length
  }
  return { pathPrefix, sha256: image.sha256, bytesUploaded }
}
