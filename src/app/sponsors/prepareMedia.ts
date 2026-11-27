// Shrinking a picked file on the web before it is uploaded: the server only
// checks uploads and never resizes or transcodes them.
//
// - Logos are redrawn on a canvas within 480 × 270 when larger, as PNG, which
//   keeps their transparency.
// - Row logos are cropped to a centred square at 128 × 128, and row
//   backgrounds to the 1920:224 strip at their upper-right corner, at most
//   1920 wide, each keeping JPEG or PNG.
// - Reels are re-encoded by Mediabunny on the browser's WebCodecs to H.264 at
//   30 fps and 1 Mbit/s within 640 × 360, with AAC sound. A browser without
//   an H.264 encoder is told to use the mobile app.
import {
  fitWithin,
  LOGO_BOX,
  REEL_BOX,
  REEL_MAX_BYTES,
  ROW_BACKGROUND_BOX,
  ROW_LOGO_SIZE,
  sizeProblem
} from '../../common/sponsors/limits'
import {
  reelLengthProblem,
  SponsorRuleError
} from '../../common/sponsors/sponsorRules'
import { loadMediabunny, type Mediabunny } from './loadMediabunny'
import { NO_WEBCODECS } from './noWebCodecs'
import { blobOf } from './pickedFiles'
import { REEL_ENCODING } from './reelEncoding'
import type {
  PickedFile,
  PreparedFile,
  SponsorMediaPurpose
} from './sponsorTypes'

export { REEL_ENCODING }

export { NO_WEBCODECS }

/** A browser that cannot shrink a reel; its message is `NO_WEBCODECS`. */
export class NoWebCodecs extends SponsorRuleError {
  constructor() {
    super(NO_WEBCODECS)
    this.name = 'NoWebCodecs'
  }
}

const UNREADABLE_PICTURE = 'This picture could not be read. Try another file.'
const UNREADABLE_VIDEO = 'This video could not be read. Try another file.'
const UNSHRINKABLE_VIDEO = 'This video could not be shrunk. Try another file.'

export type { Mediabunny }

/** A decoded picture, ready to draw. */
export interface DecodedImage {
  width: number
  height: number
  source: CanvasImageSource
}

/** A canvas the shrinking draws on and exports. */
export interface DrawingCanvas {
  draw: (
    image: DecodedImage,
    from: { x: number; y: number; width: number; height: number }
  ) => void
  toBytes: (type: string) => Promise<Uint8Array>
}

/** What the web's shrinking uses, so a test can stand in for the browser. */
export interface WebMedia {
  decodeImage: (url: string) => Promise<DecodedImage>
  canvas: (width: number, height: number) => DrawingCanvas
  readBlob: (url: string) => Promise<Blob>
  objectUrl: (bytes: Uint8Array, type: string) => string
  /** Whether the browser has WebCodecs' `VideoEncoder` at all. */
  hasVideoEncoder: () => boolean
  loadMediabunny: () => Promise<Mediabunny>
}

async function decodeImage(url: string): Promise<DecodedImage> {
  const image = new Image()
  image.decoding = 'async'
  image.src = url
  try {
    await image.decode()
  } catch {
    throw new SponsorRuleError(UNREADABLE_PICTURE)
  }
  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    source: image
  }
}

function canvas(width: number, height: number): DrawingCanvas {
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  const context = element.getContext('2d')
  return {
    draw(image, from) {
      if (context == null) throw new SponsorRuleError(UNREADABLE_PICTURE)
      context.imageSmoothingQuality = 'high'
      context.drawImage(
        image.source,
        from.x,
        from.y,
        from.width,
        from.height,
        0,
        0,
        width,
        height
      )
    },
    async toBytes(type) {
      const blob = await new Promise<Blob | null>(resolve => {
        element.toBlob(resolve, type, 0.9)
      })
      if (blob == null) throw new SponsorRuleError(UNREADABLE_PICTURE)
      return new Uint8Array(await blob.arrayBuffer())
    }
  }
}

export const browserMedia: WebMedia = {
  decodeImage,
  canvas,
  // A picked file is read from its File: the page may not fetch `blob:`.
  readBlob: async url => blobOf(url) ?? (await (await fetch(url)).blob()),
  objectUrl: (bytes, type) => URL.createObjectURL(new Blob([bytes], { type })),
  hasVideoEncoder: () => typeof VideoEncoder !== 'undefined',
  loadMediabunny
}

/** A picture's type for its purpose: logos are PNG, row pictures keep theirs. */
function pictureType(purpose: SponsorMediaPurpose, picked: PickedFile): string {
  if (purpose === 'logo') return 'image/png'
  return picked.type === 'image/png' ? 'image/png' : 'image/jpeg'
}

async function preparePicture(
  purpose: Exclude<SponsorMediaPurpose, 'reel'>,
  picked: PickedFile,
  media: WebMedia
): Promise<PreparedFile> {
  const image = await media.decodeImage(picked.url)
  const type = pictureType(purpose, picked)
  const { width, height } = image
  if (!(width > 0) || !(height > 0))
    throw new SponsorRuleError(UNREADABLE_PICTURE)
  let from = { x: 0, y: 0, width, height }
  let to: { width: number; height: number }
  if (purpose === 'logo') {
    // A logo that already fits is sent as it is.
    if (width <= LOGO_BOX.width && height <= LOGO_BOX.height) {
      const blob = await media.readBlob(picked.url)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return { ...picked, type, bytes, size: bytes.length, width, height }
    }
    to = fitWithin(width, height, LOGO_BOX)
  } else if (purpose === 'rowLogo') {
    const side = Math.min(width, height)
    from = {
      x: Math.floor((width - side) / 2),
      y: Math.floor((height - side) / 2),
      width: side,
      height: side
    }
    to = { width: ROW_LOGO_SIZE, height: ROW_LOGO_SIZE }
  } else {
    const aspect = ROW_BACKGROUND_BOX.width / ROW_BACKGROUND_BOX.height
    // The widest strip of the background's aspect, at its upper right.
    const stripWidth = Math.min(width, Math.round(height * aspect))
    const stripHeight = Math.min(height, Math.round(stripWidth / aspect))
    from = {
      x: width - stripWidth,
      y: 0,
      width: stripWidth,
      height: stripHeight
    }
    const outWidth = Math.min(ROW_BACKGROUND_BOX.width, stripWidth)
    to = {
      width: outWidth,
      height: Math.min(
        ROW_BACKGROUND_BOX.height,
        Math.max(1, Math.round(outWidth / aspect))
      )
    }
  }
  const drawing = media.canvas(to.width, to.height)
  drawing.draw(image, from)
  const bytes = await drawing.toBytes(type)
  return {
    name: picked.name,
    type,
    size: bytes.length,
    bytes,
    url: media.objectUrl(bytes, type),
    width: to.width,
    height: to.height
  }
}

async function prepareReel(
  picked: PickedFile,
  media: WebMedia
): Promise<PreparedFile> {
  if (!media.hasVideoEncoder()) throw new NoWebCodecs()
  const mb = await media.loadMediabunny()
  const input = new mb.Input({
    source: new mb.BlobSource(await media.readBlob(picked.url)),
    formats: mb.ALL_FORMATS
  })
  let durationSec: number
  let track: Awaited<ReturnType<typeof input.getPrimaryVideoTrack>>
  try {
    durationSec = await input.computeDuration()
    track = await input.getPrimaryVideoTrack()
  } catch {
    throw new SponsorRuleError(UNREADABLE_VIDEO)
  }
  const tooLong = reelLengthProblem(durationSec)
  if (tooLong != null) throw new SponsorRuleError(tooLong)
  if (track == null) throw new SponsorRuleError(UNREADABLE_VIDEO)
  const { width, height } = fitWithin(
    await track.getDisplayWidth(),
    await track.getDisplayHeight(),
    REEL_BOX
  )
  if (!(await mb.canEncodeVideo(REEL_ENCODING.codec, { width, height })))
    throw new NoWebCodecs()
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat(),
    target: new mb.BufferTarget()
  })
  const conversion = await mb.Conversion.init({
    input,
    output,
    video: {
      codec: REEL_ENCODING.codec,
      width,
      height,
      fit: 'fill',
      frameRate: REEL_ENCODING.frameRate,
      quality: new mb.Quality({ bitrate: REEL_ENCODING.videoBitrate })
    },
    audio: {
      codec: 'aac',
      quality: new mb.Quality({ bitrate: REEL_ENCODING.audioBitrate })
    }
  })
  if (!conversion.isValid) throw new SponsorRuleError(UNSHRINKABLE_VIDEO)
  try {
    await conversion.execute()
  } catch {
    throw new SponsorRuleError(UNSHRINKABLE_VIDEO)
  }
  const buffer = output.target.buffer
  if (buffer == null) throw new SponsorRuleError(UNSHRINKABLE_VIDEO)
  const bytes = new Uint8Array(buffer)
  if (bytes.length > REEL_MAX_BYTES)
    throw new SponsorRuleError(
      sizeProblem('reel', bytes.length) ?? UNSHRINKABLE_VIDEO
    )
  return {
    name: picked.name,
    type: 'video/mp4',
    size: bytes.length,
    bytes,
    url: media.objectUrl(bytes, 'video/mp4'),
    width,
    height,
    durationMs: Math.round(durationSec * 1000),
    durationSec
  }
}

/**
 * `picked`, shrunk for `purpose` and ready to upload. A file that cannot be
 * shrunk rejects with the sentence the screen shows.
 */
export async function prepareMedia(
  purpose: SponsorMediaPurpose,
  picked: PickedFile,
  media: WebMedia = browserMedia
): Promise<PreparedFile> {
  if (purpose === 'reel') return await prepareReel(picked, media)
  return await preparePicture(purpose, picked, media)
}
