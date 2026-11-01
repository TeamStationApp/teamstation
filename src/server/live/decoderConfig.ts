import { boxesIn, hvcCPath, hvcCUnits } from './holeFiller'

/**
 * Whether a publish can share a recording's init segment.
 *
 * Every picture in an `hvc1` track relies on the parameter sets in its init
 * segment, and every sound frame on the AAC configuration there. A publish
 * that continues a recording under the same name replaces that init segment,
 * so one configured differently leaves everything already recorded undecodable
 * (`spawnPrepared` gives it an init segment of its own instead). The comparison
 * is made before any writer starts: the publish's sequence headers on one side
 * and the init segment FFmpeg wrote from another publish's on the other.
 *
 * The bytes of the parameter sets are compared, not the fields read from them:
 * resolution, profile, level, chroma, bit depth and any frame rate in the VUI
 * all live there, and so does anything else a decoder reads. A frame rate that
 * is in no parameter set is no part of what a decoder is configured with:
 * those publishes differ only in timestamps, which each segment carries.
 */

/** What a decoder is told about a recording before its first picture. */
export interface DecoderConfiguration {
  /** Its VPS, SPS and PPS units, in hexadecimal, sorted. */
  parameterSets: string[]
  /** The AAC `AudioSpecificConfig`. Absent with no sound track. */
  sound?: Buffer
}

/** What a publish has said about itself so far. */
export interface HeardPublish {
  /** The body of its HEVC sequence header. */
  hevcHeader?: Buffer
  /** Its `AudioSpecificConfig`. */
  soundHeader?: Buffer
  /** Its metadata was read, and named no sound codec. */
  says?: { noSound: boolean }
}

/** VPS, SPS and PPS: what a slice refers to. */
const PARAMETER_SET_TYPES = new Set([32, 33, 34])

function parameterSets(hvcC: Buffer): string[] {
  return hvcCUnits(hvcC)
    .units.filter(nal => PARAMETER_SET_TYPES.has((nal[0] >> 1) & 0x3f))
    .map(nal => nal.toString('hex'))
    .sort()
}

/** The AAC configuration in an `esds` box's descriptors. */
function audioSpecificConfig(esds: Buffer): Buffer | undefined {
  let at = 4
  while (at < esds.length) {
    const tag = esds[at++]
    let length = 0
    let more = true
    while (more && at < esds.length) {
      more = (esds[at] & 0x80) !== 0
      length = (length << 7) | (esds[at++] & 0x7f)
    }
    if (tag === 5) return esds.subarray(at, at + length)
    // The ES and decoder descriptors hold the rest: past their own fields.
    if (tag === 3) at += 3
    else if (tag === 4) at += 13
    else at += length
  }
  return undefined
}

function soundOf(init: Buffer): Buffer | undefined {
  const moov = boxesIn(init, 0, init.length).find(box => box.type === 'moov')
  if (moov == null) return undefined
  for (const trak of boxesIn(init, moov.start + moov.header, moov.end)) {
    if (trak.type !== 'trak') continue
    let parent = trak
    for (const type of ['mdia', 'minf', 'stbl', 'stsd']) {
      const child = boxesIn(
        init,
        parent.start + parent.header,
        parent.end
      ).find(box => box.type === type)
      if (child == null) break
      parent = child
    }
    if (parent.type !== 'stsd') continue
    const entry = boxesIn(init, parent.start + 16, parent.end).find(
      box => box.type === 'mp4a'
    )
    if (entry == null) continue
    // A sound sample entry's own fields come before its child boxes.
    const esds = boxesIn(init, entry.start + 8 + 28, entry.end).find(
      box => box.type === 'esds'
    )
    if (esds == null) continue
    return audioSpecificConfig(
      init.subarray(esds.start + esds.header, esds.end)
    )
  }
  return undefined
}

/** An init segment's configuration, or undefined when it holds no `hvcC`. */
export function configurationOfInit(
  init: Buffer
): DecoderConfiguration | undefined {
  try {
    const path = hvcCPath(init)
    if (path == null) return undefined
    const hvcC = path[path.length - 1]
    return {
      parameterSets: parameterSets(
        init.subarray(hvcC.start + hvcC.header, hvcC.end)
      ),
      sound: soundOf(init)
    }
  } catch {
    return undefined
  }
}

/**
 * The HEVCDecoderConfigurationRecord in a video sequence header's FLV body,
 * classic (a codec nibble of 12 and an `AVCPacketType` of 0) or Enhanced RTMP
 * (the extended bit, `PacketTypeSequenceStart`, then the fourcc). Both put it
 * five bytes in. Undefined for any other packet.
 */
export function hevcHeaderOf(data: Buffer | undefined): Buffer | undefined {
  if (data == null || data.length <= 5) return undefined
  const classic = (data[0] & 0x8f) === 12 && data[1] === 0
  const enhanced =
    (data[0] & 0x8f) === 0x80 && data.toString('latin1', 1, 5) === 'hvc1'
  return classic || enhanced ? data.subarray(5) : undefined
}

/** The `AudioSpecificConfig` in an AAC sequence header's FLV body. */
export function soundHeaderOf(data: Buffer | undefined): Buffer | undefined {
  if (data == null || data.length <= 2) return undefined
  return data[0] >> 4 === 10 && data[1] === 0 ? data.subarray(2) : undefined
}

/**
 * Whether a publish would have to replace what `held` describes. One that has
 * shown no readable header has nothing to say it matches. Sound that has not
 * been heard yet is no difference: a publisher's sound can follow its first
 * picture. Its metadata saying there is none is.
 */
export function publishDiffers(
  held: DecoderConfiguration,
  heard: HeardPublish
): boolean {
  if (heard.hevcHeader == null) return true
  let published: string[]
  try {
    published = parameterSets(heard.hevcHeader)
  } catch {
    return true
  }
  if (published.join() !== held.parameterSets.join()) return true
  if (held.sound == null) return false
  if (heard.soundHeader != null) return !heard.soundHeader.equals(held.sound)
  return heard.says?.noSound === true
}
