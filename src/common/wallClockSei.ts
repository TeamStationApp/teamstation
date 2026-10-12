/**
 * The wall clock a frame carries in its own bitstream.
 *
 * A frame stamped with this says when it was taken, on the server's clock
 * when the encoder had measured that clock and on its own otherwise. Every
 * copy of the stream keeps it, because every leg is `-c copy`: the RTMP
 * ingest, the live HLS, the recording a stream becomes and an upload's remux.
 * So a video carrying it has a frame-exact wall-clock timeline, live and
 * recorded, across any outage and any reconnect.
 *
 * It is a `user_data_unregistered` SEI message (payload type 5): NAL type 6
 * for H.264, prefix SEI (NAL type 39) for HEVC. Its payload is
 *
 * | Bytes | Field                                              |
 * | ----- | -------------------------------------------------- |
 * | 16    | `WALL_CLOCK_SEI_UUID`, which says the rest is ours |
 * | 1     | version, 1                                         |
 * | 8     | wall ms, signed, big-endian                        |
 * | 1     | flags: bit 0 set when the clock is the server's    |
 *
 * TS Director writes the same bytes (`DirectorCore/WallClockSEI.swift`), and
 * both sides check `src/test/wallClockSeiVectors.json`.
 */

/** Which bitstream a NAL unit belongs to. */
export type SeiCodec = 'h264' | 'hevc'

/** What one frame says about itself. */
export interface WallClockStamp {
  /** The frame's wall time, in ms since the epoch. */
  wallMs: number
  /** The clock was moved onto the server's by a measured offset. */
  corrected: boolean
}

/** Ours, and nobody else's: `5e2f0c4a-7d1b-4b6e-9c38-1f0a6d2e8b71`. */
export const WALL_CLOCK_SEI_UUID = Uint8Array.from([
  0x5e, 0x2f, 0x0c, 0x4a, 0x7d, 0x1b, 0x4b, 0x6e, 0x9c, 0x38, 0x1f, 0x0a, 0x6d,
  0x2e, 0x8b, 0x71
])
export const WALL_CLOCK_SEI_VERSION = 1
/** `user_data_unregistered`. */
export const USER_DATA_UNREGISTERED = 5
/** UUID, version, wall ms and flags. */
const PAYLOAD_BYTES = 16 + 1 + 8 + 1

/** 2000-01-01 and 2100-01-01, in ms since the epoch. */
const EARLIEST_WALL_MS = 946_684_800_000
const LATEST_WALL_MS = 4_102_444_800_000

/**
 * Whether a wall time could be a frame's: a whole number of ms in this
 * century. A damaged or foreign message can hold any 64 bits, and a time
 * outside what a date can hold would be stored as no time at all.
 */
export function isPlausibleWallMs(wallMs: number): boolean {
  return (
    Number.isSafeInteger(wallMs) &&
    wallMs >= EARLIEST_WALL_MS &&
    wallMs < LATEST_WALL_MS
  )
}

/** The SEI NAL type in each codec: H.264's SEI, HEVC's prefix SEI. */
export const SEI_NAL_TYPE: Record<SeiCodec, number> = { h264: 6, hevc: 39 }

/** The NAL unit's type, from its header. */
export function nalType(codec: SeiCodec, nal: Uint8Array): number {
  return codec === 'h264' ? nal[0] & 0x1f : (nal[0] >> 1) & 0x3f
}

/** The header bytes before the SEI messages. */
function headerLength(codec: SeiCodec): number {
  return codec === 'h264' ? 1 : 2
}

/**
 * Whether a NAL unit is a coded picture slice: a frame's picture, which every
 * SEI of the frame has to come before.
 */
export function isSliceNal(codec: SeiCodec, nal: Uint8Array): boolean {
  const type = nalType(codec, nal)
  return codec === 'h264' ? type >= 1 && type <= 5 : type <= 31
}

/**
 * The stamp as one NAL unit: header, the SEI message and its trailing bits,
 * with emulation prevention applied. No start code and no length prefix,
 * which are the container's.
 */
export function encodeWallClockSei(
  codec: SeiCodec,
  stamp: WallClockStamp
): Uint8Array {
  const payload = new Uint8Array(PAYLOAD_BYTES)
  payload.set(WALL_CLOCK_SEI_UUID, 0)
  payload[16] = WALL_CLOCK_SEI_VERSION
  new DataView(payload.buffer).setBigInt64(17, BigInt(stamp.wallMs))
  payload[25] = stamp.corrected ? 1 : 0

  // One message: type and size each fit in one byte, then the payload and
  // the stop bit that ends the RBSP.
  const rbsp = new Uint8Array(2 + PAYLOAD_BYTES + 1)
  rbsp[0] = USER_DATA_UNREGISTERED
  rbsp[1] = PAYLOAD_BYTES
  rbsp.set(payload, 2)
  rbsp[rbsp.length - 1] = 0x80

  const header =
    codec === 'h264'
      ? [SEI_NAL_TYPE.h264]
      : // nuh_layer_id 0, nuh_temporal_id_plus1 1.
        [SEI_NAL_TYPE.hevc << 1, 0x01]
  const body = addEmulationPrevention(rbsp)
  const nal = new Uint8Array(header.length + body.length)
  nal.set(header, 0)
  nal.set(body, header.length)
  return nal
}

/**
 * The stamp a SEI NAL unit carries, or null when it carries none of ours.
 *
 * Every message in the unit is looked at, because an encoder puts its own
 * `user_data_unregistered` beside ours (x265 writes its version and settings
 * in one). A message with another UUID, another version, a size that runs
 * past the end of the unit, or a wall time outside this century is passed
 * over rather than misread.
 */
export function decodeWallClockSei(
  codec: SeiCodec,
  nal: Uint8Array
): WallClockStamp | null {
  if (nal.length <= headerLength(codec)) return null
  if (nalType(codec, nal) !== SEI_NAL_TYPE[codec]) return null
  const rbsp = removeEmulationPrevention(nal.subarray(headerLength(codec)))
  let at = 0
  // A type or a size: every `ff` adds 255 and the first other byte ends it.
  const readCoded = (): number => {
    let value = 0
    while (at < rbsp.length && rbsp[at] === 0xff) value += rbsp[at++]
    return at < rbsp.length ? value + rbsp[at++] : -1
  }
  // Each message at least a type byte and a size byte, and the stop bit last.
  while (at + 2 < rbsp.length) {
    const type = readCoded()
    const size = readCoded()
    if (type < 0 || size < 0 || at + size > rbsp.length) return null
    const payload = rbsp.subarray(at, at + size)
    at += size
    if (type !== USER_DATA_UNREGISTERED || size < PAYLOAD_BYTES) continue
    if (!WALL_CLOCK_SEI_UUID.every((byte, i) => payload[i] === byte)) continue
    if (payload[16] !== WALL_CLOCK_SEI_VERSION) continue
    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength
    )
    const wallMs = Number(view.getBigInt64(17))
    if (!isPlausibleWallMs(wallMs)) continue
    return { wallMs, corrected: (payload[25] & 1) === 1 }
  }
  return null
}

/**
 * Inserts `03` after every two zero bytes that a byte of 3 or less follows,
 * so nothing inside the unit reads as a start code.
 */
export function addEmulationPrevention(rbsp: Uint8Array): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return Uint8Array.from(out)
}

/** Takes out the `03` that follows every two zero bytes. */
export function removeEmulationPrevention(ebsp: Uint8Array): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (const byte of ebsp) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return Uint8Array.from(out)
}
