// The sizes sponsor uploads are held to, and the checks that read a probe.
// The client shrinks every upload to fit; the server only checks, with the
// same numbers and the same sentences.
import { REEL_MAX_SEC, REEL_MIN_SEC, reelLengthProblem } from './sponsorRules'
import type { SponsorMediaPurpose } from './types'

const count = (value: number): string => value.toLocaleString('en-US')
const megabytes = (bytes: number): string =>
  `${Math.round(bytes / 100_000) / 10} MB`
/** Frame rates read from a fraction land a hair off; this is not a frame. */
const FPS_SLACK = 1e-6

export interface Box {
  width: number
  height: number
}

/** A game logo fits in this, over the video. */
export const LOGO_BOX: Box = { width: 480, height: 270 }
/** A sponsored row's logo is this square. */
export const ROW_LOGO_SIZE = 128
/** A sponsored row's background fits in this. */
export const ROW_BACKGROUND_BOX: Box = { width: 1920, height: 224 }
/** A reel fits in this. */
export const REEL_BOX: Box = { width: 640, height: 360 }
export const REEL_MAX_BYTES = 3_200_000
/** Bits a second, over the whole file. */
export const REEL_MAX_BITRATE = 1_700_000
export const REEL_MAX_FPS = 30
export { REEL_MAX_SEC, REEL_MIN_SEC }

/** The node's sample video: 1080p, H.264 or HEVC, at most two minutes. */
export const SAMPLE_BOX: Box = { width: 1920, height: 1080 }
export const SAMPLE_MAX_BYTES = 120_000_000
export const SAMPLE_MAX_SEC = 120
export const SAMPLE_MAX_FPS = 60
export const SAMPLE_CODECS: readonly string[] = ['h264', 'hevc']

export const LOGO_MAX_BYTES = 1_000_000
export const ROW_IMAGE_MAX_BYTES = 4_000_000

/** The most bytes an upload for `purpose` may have. */
export function maxBytesFor(purpose: SponsorMediaPurpose): number {
  if (purpose === 'logo') return LOGO_MAX_BYTES
  if (purpose === 'reel') return REEL_MAX_BYTES
  return ROW_IMAGE_MAX_BYTES
}

/** Why `bytes` is too many for an upload for `purpose`, or `null`. */
export function sizeProblem(
  purpose: SponsorMediaPurpose,
  bytes: number
): string | null {
  const most = maxBytesFor(purpose)
  if (bytes <= most) return null
  const noun =
    purpose === 'logo' ? 'Logos' : purpose === 'reel' ? 'Reels' : 'Images'
  return `${noun} can be at most ${megabytes(most)}.`
}

/** What ffprobe says of a video, as the checks read it. */
export interface VideoProbe {
  /** `codec_name`, e.g. `h264`. */
  codec: string
  width: number
  height: number
  /** `avg_frame_rate`, as a number. */
  fps: number
  durationSec: number
  /** The format's bits a second, or 0 when ffprobe did not say. */
  bitRate: number
}

/** A picture's type and size, read from its header. */
export interface ImageHeader {
  type: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

/** Why a reel's probe and size are refused, or `null`. */
export function reelProbeProblem(
  probe: VideoProbe,
  bytes: number
): string | null {
  const size = sizeProblem('reel', bytes)
  if (size != null) return size
  if (probe.codec !== 'h264') return 'Reels must be H.264 video.'
  if (probe.width > REEL_BOX.width || probe.height > REEL_BOX.height)
    return `Reels can be at most ${REEL_BOX.width} × ${REEL_BOX.height}.`
  if (!(probe.fps > 0) || probe.fps > REEL_MAX_FPS + FPS_SLACK)
    return `Reels can be at most ${REEL_MAX_FPS} frames a second.`
  const length = reelLengthProblem(probe.durationSec)
  if (length != null) return length
  if (probe.bitRate > REEL_MAX_BITRATE)
    return `Reels can be at most ${REEL_MAX_BITRATE / 1_000_000} Mbit/s.`
  return null
}

/** Why a sample video of `bytes` is refused for its size alone, or `null`. */
export function sampleSizeProblem(bytes: number): string | null {
  return bytes > SAMPLE_MAX_BYTES
    ? `The sample video can be at most ${count(SAMPLE_MAX_BYTES / 1_000_000)} MB.`
    : null
}

/** Why the node's sample video is refused, or `null`. */
export function sampleProbeProblem(
  probe: VideoProbe,
  bytes: number
): string | null {
  const size = sampleSizeProblem(bytes)
  if (size != null) return size
  if (!SAMPLE_CODECS.includes(probe.codec))
    return 'The sample video must be H.264 or HEVC.'
  if (probe.width !== SAMPLE_BOX.width || probe.height !== SAMPLE_BOX.height)
    return `The sample video must be ${count(SAMPLE_BOX.width)} × ${count(SAMPLE_BOX.height)}.`
  if (!(probe.fps > 0) || probe.fps > SAMPLE_MAX_FPS + FPS_SLACK)
    return `The sample video can be at most ${SAMPLE_MAX_FPS} frames a second.`
  if (!(probe.durationSec > 0) || probe.durationSec > SAMPLE_MAX_SEC)
    return `The sample video can be at most ${SAMPLE_MAX_SEC / 60} minutes long.`
  return null
}

/** Why a picture for `purpose` is refused, or `null`. */
export function imageProblem(
  purpose: Exclude<SponsorMediaPurpose, 'reel'>,
  image: ImageHeader | null,
  bytes: number
): string | null {
  const size = sizeProblem(purpose, bytes)
  if (size != null) return size
  if (purpose === 'logo') {
    if (image?.type !== 'image/png') return 'Logos must be PNG files.'
    if (image.width > LOGO_BOX.width || image.height > LOGO_BOX.height)
      return `Logos can be at most ${LOGO_BOX.width} × ${LOGO_BOX.height} pixels.`
    return null
  }
  if (image == null) return 'Images must be JPEG or PNG.'
  if (purpose === 'rowLogo') {
    return image.width === ROW_LOGO_SIZE && image.height === ROW_LOGO_SIZE
      ? null
      : `Row logos must be ${ROW_LOGO_SIZE} × ${ROW_LOGO_SIZE} pixels.`
  }
  return image.width > ROW_BACKGROUND_BOX.width ||
    image.height > ROW_BACKGROUND_BOX.height
    ? `Backgrounds can be at most ${count(ROW_BACKGROUND_BOX.width)} × ${ROW_BACKGROUND_BOX.height} pixels.`
    : null
}

/**
 * `width` × `height` scaled down, never up, to fit in `box`, keeping the
 * aspect ratio, each side even (as a video encoder needs) and at least 2.
 */
export function fitWithin(width: number, height: number, box: Box): Box {
  const scale = Math.min(1, box.width / width, box.height / height)
  // A hair over, so 3840 × (640 / 3840) is 640 and not 639.99….
  const even = (value: number): number =>
    Math.max(2, Math.floor((value * scale) / 2 + 1e-9) * 2)
  return { width: even(width), height: even(height) }
}
