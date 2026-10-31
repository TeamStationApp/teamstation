import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

/** A decoded image: one RGBA quad per pixel, whatever the file stored. */
export interface Raster {
  format: 'PNG' | 'JPEG'
  /** The channels the file itself stored, e.g. `RGB`. */
  mode: string
  width: number
  height: number
  data: Buffer
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_END = Buffer.from('IEND', 'ascii')
const PNG_MODES: Record<number, string> = {
  0: 'L',
  2: 'RGB',
  3: 'P',
  4: 'LA',
  6: 'RGBA'
}

/**
 * Both decoders forgive a file that stops early, and a capture cut short is
 * exactly what these checks exist to catch, so the end of each is proved.
 */
export function decodeRaster(bytes: Buffer): Raster {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    assert(
      bytes.subarray(-8, -4).equals(PNG_END),
      'Truncated PNG: no end chunk'
    )
    const { width, height, data } = PNG.sync.read(bytes)
    const mode = PNG_MODES[bytes[25]] ?? 'unknown'
    return { format: 'PNG', mode, width, height, data }
  }
  assert(
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    'Unknown image codec'
  )
  assert(
    bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217,
    'Truncated JPEG: no end marker'
  )
  const { width, height, data } = jpeg.decode(bytes, {
    tolerantDecoding: false,
    useTArray: true
  })
  return {
    format: 'JPEG',
    mode: 'RGB',
    width,
    height,
    data: Buffer.from(data)
  }
}

export function encodePng(
  width: number,
  height: number,
  data: Uint8Array
): Buffer {
  const png = new PNG({ width, height })
  png.data = Buffer.from(data)
  return PNG.sync.write(png)
}

/** Writes a JPEG as PNG and proves the PNG holds exactly the same pixels. */
export function pngFromJpeg(bytes: Buffer): {
  png: Buffer
  decodedPixelsEqual: true
  decodedPixelSha256: string
} {
  const before = decodeRaster(bytes)
  const png = encodePng(before.width, before.height, before.data)
  const after = decodeRaster(png)
  assert(
    after.width === before.width &&
      after.height === before.height &&
      after.data.equals(before.data),
    'PNG conversion changed the decoded pixels'
  )
  return {
    png,
    decodedPixelsEqual: true,
    decodedPixelSha256: createHash('sha256').update(before.data).digest('hex')
  }
}

/** Rounds a half to the even neighbour, so a box on .5 stays where it was. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value)
  const gap = value - floor
  if (gap !== 0.5) return Math.round(value)
  return floor % 2 === 0 ? floor : floor + 1
}
