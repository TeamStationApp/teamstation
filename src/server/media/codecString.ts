/**
 * The RFC 6381 `CODECS` string for a fragmented MP4, read out of the file.
 *
 * A master playlist has to name its codecs, and name them exactly: Safari
 * decides whether to even try an HEVC stream from this string, and a wrong one
 * is worse than none. FFmpeg does not write it when it is only copying
 * streams, because it never parses the extradata it is passing through — so it
 * is read here, from the `hvcC` or `avcC` box in the file's own sample
 * description.
 *
 * Nothing is decoded and nothing is guessed: these are the bytes the muxer
 * wrote, interpreted as the specifications define them.
 */

export interface TrackCodec {
  /** `video` or `audio`. */
  kind: 'video' | 'audio'
  /** e.g. `hvc1.1.6.L120.B0`, `avc1.640028`, `mp4a.40.2`. */
  codec: string
}

/** Walks the box tree and returns the codec of every track it understands. */
export function codecsFromInit(init: Buffer): TrackCodec[] {
  const found: TrackCodec[] = []
  for (const stsd of findBoxes(init, [
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
    'stsd'
  ])) {
    // `stsd` is a full box: version and flags, then an entry count.
    for (const entry of boxesIn(stsd.subarray(8))) {
      const codec = codecFromSampleEntry(entry)
      if (codec != null) found.push(codec)
    }
  }
  return found
}

/** The `CODECS` attribute value: video first, then audio, comma separated. */
export function codecsAttribute(tracks: TrackCodec[]): string {
  const order = (track: TrackCodec): number => (track.kind === 'video' ? 0 : 1)
  return [...tracks]
    .sort((a, b) => order(a) - order(b))
    .map(track => track.codec)
    .join(',')
}

function codecFromSampleEntry(entry: Box): TrackCodec | undefined {
  // A visual sample entry is 78 bytes of fixed fields before its child boxes;
  // an audio one is 28.
  if (entry.type === 'hvc1' || entry.type === 'hev1') {
    const hvcC = childBox(entry.payload.subarray(78), 'hvcC')
    if (hvcC == null) return undefined
    return { kind: 'video', codec: `${entry.type}.${hevcCodec(hvcC)}` }
  }
  if (entry.type === 'avc1' || entry.type === 'avc3') {
    const avcC = childBox(entry.payload.subarray(78), 'avcC')
    if (avcC == null || avcC.length < 4) return undefined
    const hex = avcC.subarray(1, 4).toString('hex')
    return { kind: 'video', codec: `${entry.type}.${hex}` }
  }
  if (entry.type === 'mp4a') {
    const esds = childBox(entry.payload.subarray(28), 'esds')
    const objectType = esds == null ? undefined : audioObjectType(esds)
    // 2 is AAC-LC, which is what everything here produces; when the descriptor
    // cannot be read, saying so beats inventing a profile.
    return {
      kind: 'audio',
      codec: objectType == null ? 'mp4a.40.2' : `mp4a.40.${objectType}`
    }
  }
  return undefined
}

/**
 * `<profile_space><profile_idc>.<compatibility>.<tier><level>.<constraints>`,
 * per the HEVC part of RFC 6381.
 */
function hevcCodec(hvcC: Buffer): string {
  const profileSpace = (hvcC[1] >> 6) & 0x03
  const tierFlag = (hvcC[1] >> 5) & 0x01
  const profileIdc = hvcC[1] & 0x1f
  const compatibility = hvcC.readUInt32BE(2)
  const levelIdc = hvcC[12]

  // The compatibility flags go out in reverse bit order, with leading zeros
  // dropped — which is what the specification asks for, however odd it looks.
  const reversed = reverseBits32(compatibility)

  const parts = [
    `${'ABC'[profileSpace - 1] ?? ''}${profileIdc}`,
    reversed.toString(16).toUpperCase(),
    `${tierFlag === 1 ? 'H' : 'L'}${levelIdc}`
  ]

  // Six constraint bytes, most significant first, with trailing zero bytes
  // left off.
  const constraints: string[] = []
  for (let i = 6; i <= 11; i++) {
    constraints.push(hvcC[i].toString(16).toUpperCase().padStart(2, '0'))
  }
  while (
    constraints.length > 0 &&
    constraints[constraints.length - 1] === '00'
  ) {
    constraints.pop()
  }
  return [...parts, ...constraints].join('.')
}

function reverseBits32(value: number): number {
  let out = 0
  for (let i = 0; i < 32; i++) {
    out = (out << 1) | ((value >>> i) & 1)
  }
  return out >>> 0
}

/**
 * The AAC object type out of an `esds` descriptor. The descriptors nest and
 * use variable-length sizes, so this looks for the DecoderConfigDescriptor
 * (tag 4) and reads the five bits that follow its header.
 */
function audioObjectType(esds: Buffer): number | undefined {
  // Skip the full-box version and flags.
  const cursor = { at: 4 }

  const es = readDescriptor(esds, cursor)
  if (es?.tag !== 0x03) return undefined

  // ES_Descriptor: id (2) and flags (1). The flags say which optional fields
  // follow, and skipping a present one would land mid-descriptor.
  const inner = { at: 3 }
  const flags = es.body[2]
  if ((flags & 0x80) !== 0) inner.at += 2 // depends on another stream
  if ((flags & 0x40) !== 0) inner.at += 1 + es.body[inner.at] // a URL
  if ((flags & 0x20) !== 0) inner.at += 2 // an OCR stream

  const config = readDescriptor(es.body, inner)
  if (config?.tag !== 0x04) return undefined

  // DecoderConfigDescriptor: objectTypeIndication, streamType and buffer and
  // bitrate fields — 13 bytes — then the DecoderSpecificInfo.
  const specific = readDescriptor(config.body, { at: 13 })
  if (specific?.tag !== 0x05) return undefined
  if (specific.body.length < 1) return undefined

  // The first five bits of the AudioSpecificConfig.
  return (specific.body[0] >> 3) & 0x1f
}

interface Descriptor {
  tag: number
  body: Buffer
}

/**
 * One MPEG-4 descriptor. Sizes are a variable-length quantity of up to four
 * bytes, seven bits each, and writers pad them out to four as often as not, so
 * the length cannot be assumed.
 */
function readDescriptor(
  buffer: Buffer,
  cursor: { at: number }
): Descriptor | undefined {
  if (cursor.at + 1 > buffer.length) return undefined
  const tag = buffer[cursor.at]
  cursor.at += 1

  let size = 0
  for (let i = 0; i < 4; i++) {
    if (cursor.at >= buffer.length) return undefined
    const byte = buffer[cursor.at]
    cursor.at += 1
    size = (size << 7) | (byte & 0x7f)
    if ((byte & 0x80) === 0) break
  }

  const end = Math.min(cursor.at + size, buffer.length)
  const body = buffer.subarray(cursor.at, end)
  cursor.at = end
  return { tag, body }
}

interface Box {
  type: string
  payload: Buffer
}

/** Every box at this level, ignoring anything truncated. */
function* boxesIn(buffer: Buffer): Generator<Box> {
  let at = 0
  while (at + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    // A size of 0 means "to the end"; 1 means a 64-bit size follows, which
    // nothing here writes for these boxes.
    const end = size === 0 ? buffer.length : at + size
    if (size < 8 || end > buffer.length) return
    yield { type, payload: buffer.subarray(at + 8, end) }
    at = end
  }
}

function childBox(buffer: Buffer, type: string): Buffer | undefined {
  for (const box of boxesIn(buffer)) {
    if (box.type === type) return box.payload
  }
  return undefined
}

/** Every box reached by following `path` down the tree. */
function findBoxes(buffer: Buffer, path: string[]): Buffer[] {
  let level = [buffer]
  for (const type of path) {
    const next: Buffer[] = []
    for (const parent of level) {
      for (const box of boxesIn(parent)) {
        if (box.type === type) next.push(box.payload)
      }
    }
    level = next
  }
  return level
}
