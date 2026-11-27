import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type MarkerGeometry, markerGeometry, unwrapMarker } from './readMarker'

/**
 * Where each moment of a live HLS stream belongs, read off the stream itself.
 *
 * A player reports a position, and the playlist says which segment holds that
 * position: the segments' durations, added up from the first one, are the
 * timeline every HLS player builds. The fake broadcaster burns the wall clock
 * into every frame, so decoding the first frame of each segment says which
 * picture the playlist puts at the start of it, and so which picture belongs
 * at every position after.
 *
 * That is the player's own time for a frame: a picture on screen at position
 * `t` is in step when its burned clock is the one the playlist puts at `t`.
 */

export interface Segment {
  uri: string
  /** Its media sequence number, as a player numbers it. */
  sequence: number
  durationSec: number
  /** Where it starts on the playlist's timeline. */
  startSec: number
  discontinuity: boolean
  /** `EXT-X-PROGRAM-DATE-TIME`, as wall ms, when the playlist carries it. */
  programDateTime: number | null
}

export interface Playlist {
  mediaSequence: number
  ended: boolean
  segments: Segment[]
}

/** A media playlist, as a player reads it. */
export function parsePlaylist(text: string): Playlist {
  let mediaSequence = 0
  let ended = false
  const segments: Segment[] = []
  let duration: number | null = null
  let discontinuity = false
  let programDateTime: number | null = null
  let startSec = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length))
    } else if (line === '#EXT-X-ENDLIST') {
      ended = true
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      programDateTime = Date.parse(
        line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length)
      )
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice('#EXTINF:'.length))
    } else if (line !== '' && !line.startsWith('#') && duration != null) {
      segments.push({
        uri: line,
        sequence: mediaSequence + segments.length,
        durationSec: duration,
        startSec,
        discontinuity,
        programDateTime
      })
      startSec += duration
      duration = null
      discontinuity = false
      programDateTime = null
    }
  }
  return { mediaSequence, ended, segments }
}

/**
 * The low 32 bits of the wall ms burned into a grey picture, `width` pixels
 * wide, or null when the marker is not there. `readMarker`'s rules, on one
 * byte of luma a pixel instead of a canvas.
 */
export function readMarkerGray(
  pixels: Uint8Array,
  width: number,
  geometry: MarkerGeometry
): number | null {
  const { bits, originX, originY, stride, cell, sentinelSlot } = geometry
  const quarter = Math.floor(cell / 4)
  const brightness = (x: number, y: number): number => {
    let sum = 0
    const side = cell / 2
    for (let dy = 0; dy < side; dy++)
      for (let dx = 0; dx < side; dx++) sum += pixels[(y + dy) * width + x + dx]
    return sum / (side * side)
  }
  const slot = (n: number): number =>
    brightness(originX + n * stride + quarter, originY + quarter)
  if (slot(sentinelSlot) < 160) return null
  if (brightness(originX, originY + cell + 2) > 96) return null
  let value = 0
  for (let bit = 0; bit < bits; bit++) {
    if (slot(bit) > 128) value += Math.pow(2, bit)
  }
  return value
}

/**
 * The wall clock on the first frame of every segment, each one put behind
 * the stream's `init` segment and decoded (`decode`, the video layer's
 * `decodeFirstFrame` in gray) from a file under `scratch`. `read` fetches a
 * segment by its playlist URI: the live pieces the ingest still holds and
 * the older ones its Space holds, as a player reads them. Null for a
 * segment whose first frame could not be decoded or read.
 */
export async function firstMarkers(options: {
  segments: readonly Segment[]
  nearMs: number
  init: Uint8Array
  read: (uri: string) => Promise<Uint8Array>
  decode: (file: string) => Promise<Uint8Array | null>
  scratch: string
  size?: { width: number; height: number }
}): Promise<Array<number | null>> {
  const size = options.size ?? { width: 1280, height: 720 }
  const joined = join(options.scratch, 'first-frame.mp4')
  const markers: Array<number | null> = []
  for (const segment of options.segments) {
    writeFileSync(
      joined,
      Buffer.concat([options.init, await options.read(segment.uri)])
    )
    const pixels = await options.decode(joined)
    const low =
      pixels == null || pixels.length < size.width * size.height
        ? null
        : readMarkerGray(pixels, size.width, markerGeometry(size.height))
    markers.push(low == null ? null : unwrapMarker(low, options.nearMs))
  }
  return markers
}

/**
 * The picture the playlist puts at `atSec`, as the wall clock burned into it:
 * the first frame of the segment holding `atSec`, plus how far into that
 * segment it is. Null outside the playlist, or in a segment that could not be
 * read.
 */
export function wallAtPosition(
  segments: readonly Segment[],
  markers: ReadonlyArray<number | null>,
  atSec: number
): number | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]
    if (segment.startSec > atSec + 1e-6) continue
    if (atSec > segment.startSec + segment.durationSec + 0.1) return null
    const first = markers[i]
    return first == null ? null : first + (atSec - segment.startSec) * 1000
  }
  return null
}
