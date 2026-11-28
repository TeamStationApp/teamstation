/**
 * The size of the picture a publish carries, read from the sequence parameter
 * set in its sequence header, and whether TeamStation takes it.
 *
 * What a publisher's metadata says of its width and height is never trusted:
 * the SPS is what every decoder goes by, so it is what is judged.
 */
import { STREAM_REFUSAL_PREFIXES } from '../../common/api'
import type { CodecFamily } from './decoderConfig'
import { avcCUnits, hvcCUnits } from './holeFiller'
import { Bits, skipProfileTierLevel, toRbsp } from './nalBits'

export interface PictureSize {
  width: number
  height: number
}

/** The H.264 profiles whose SPS carries chroma format and bit depths. */
const AVC_HIGH_PROFILES = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135
])

/** Reads past one H.264 `scaling_list` of `size` entries. */
function skipScalingList(bits: Bits, size: number): void {
  let last = 8
  let next = 8
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + bits.se() + 256) % 256
    last = next === 0 ? last : next
  }
}

/**
 * The width and height an H.264 SPS (a whole NAL unit, header byte first)
 * gives its pictures once cropped: macroblocks across and down, doubled down
 * for field coding, less the cropping window in chroma units.
 */
export function avcPictureSize(sps: Buffer): PictureSize {
  if ((sps[0] & 0x1f) !== 7) throw new Error('not an H.264 SPS')
  const bits = new Bits(toRbsp(sps.subarray(1)))
  const profile = bits.u(8)
  bits.skip(16)
  bits.ue()
  let chromaFormat = 1
  let separateColourPlane = false
  if (AVC_HIGH_PROFILES.has(profile)) {
    chromaFormat = bits.ue()
    if (chromaFormat === 3) separateColourPlane = bits.u(1) === 1
    bits.ue()
    bits.ue()
    bits.skip(1)
    if (bits.u(1) === 1) {
      for (let i = 0; i < (chromaFormat === 3 ? 12 : 8); i++) {
        if (bits.u(1) === 1) skipScalingList(bits, i < 6 ? 16 : 64)
      }
    }
  }
  bits.ue()
  const pocType = bits.ue()
  if (pocType === 0) {
    bits.ue()
  } else if (pocType === 1) {
    bits.skip(1)
    bits.se()
    bits.se()
    const cycle = bits.ue()
    for (let i = 0; i < cycle; i++) bits.se()
  }
  bits.ue()
  bits.skip(1)
  const widthInMbs = bits.ue() + 1
  const heightInMapUnits = bits.ue() + 1
  const frameMbsOnly = bits.u(1)
  if (frameMbsOnly === 0) bits.skip(1)
  bits.skip(1)
  const fields = 2 - frameMbsOnly
  let width = widthInMbs * 16
  let height = fields * heightInMapUnits * 16
  if (bits.u(1) === 1) {
    const [left, right, top, bottom] = [
      bits.ue(),
      bits.ue(),
      bits.ue(),
      bits.ue()
    ]
    const monochrome = separateColourPlane || chromaFormat === 0
    const unitX = monochrome || chromaFormat === 3 ? 1 : 2
    const unitY = (monochrome || chromaFormat !== 1 ? 1 : 2) * fields
    width -= unitX * (left + right)
    height -= unitY * (top + bottom)
  }
  return { width, height }
}

/**
 * The width and height an HEVC SPS (a whole NAL unit, two header bytes first)
 * gives its pictures: luma samples across and down, less the conformance
 * window in chroma units.
 */
export function hevcPictureSize(sps: Buffer): PictureSize {
  if (((sps[0] >> 1) & 0x3f) !== 33) throw new Error('not an HEVC SPS')
  const bits = new Bits(toRbsp(sps.subarray(2)))
  bits.skip(4)
  const subLayers = bits.u(3)
  bits.skip(1)
  skipProfileTierLevel(bits, subLayers)
  bits.ue()
  const chromaFormat = bits.ue()
  const separateColourPlane = chromaFormat === 3 && bits.u(1) === 1
  let width = bits.ue()
  let height = bits.ue()
  if (bits.u(1) === 1) {
    const [left, right, top, bottom] = [
      bits.ue(),
      bits.ue(),
      bits.ue(),
      bits.ue()
    ]
    const monochrome = separateColourPlane || chromaFormat === 0
    const unitX = monochrome || chromaFormat === 3 ? 1 : 2
    const unitY = monochrome || chromaFormat !== 1 ? 1 : 2
    width -= unitX * (left + right)
    height -= unitY * (top + bottom)
  }
  return { width, height }
}

/**
 * The picture size of the first SPS in a sequence header's decoder
 * configuration record (`avcC` for H.264, `hvcC` for HEVC). Undefined when it
 * holds no SPS this can read.
 */
export function pictureSizeOf(
  family: CodecFamily,
  record: Buffer
): PictureSize | undefined {
  try {
    if (family === 'h264') {
      const sps = avcCUnits(record).sps[0]
      return sps == null ? undefined : avcPictureSize(sps)
    }
    const sps = hvcCUnits(record).units.find(
      nal => ((nal[0] >> 1) & 0x3f) === 33
    )
    return sps == null ? undefined : hevcPictureSize(sps)
  } catch {
    return undefined
  }
}

/**
 * Whether TeamStation takes a picture of this size: 720p to 1080p, landscape
 * or portrait. The short side is 720 to 1080 and the long side at most 1920.
 * Frame rate is not part of it.
 */
export function sizeAccepted({ width, height }: PictureSize): boolean {
  const short = Math.min(width, height)
  return short >= 720 && short <= 1080 && Math.max(width, height) <= 1920
}

/** Why a publish of this picture size may not be recorded, or `null`. */
export function sizeRefusal(size: PictureSize): string | null {
  if (sizeAccepted(size)) return null
  return `${STREAM_REFUSAL_PREFIXES[2]} This stream is ${size.width} × ${size.height} — change the resolution and start it again.`
}
