import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The pinned ffmpeg the media tests use, or the one on the path. */
export const TEST_FFMPEG = process.env.TS_FFMPEG ?? 'ffmpeg'

/** A PNG's signature and IHDR, which is all the header reads. */
export function pngBytes(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr.writeUInt8(8, 16)
  ihdr.writeUInt8(6, 17)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr
  ])
}

/** A JPEG with an APP0 segment, a fill byte, a restart marker and `sof`. */
export function jpegBytes(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00
  ])
  const frame = Buffer.alloc(19)
  frame.writeUInt8(0xff, 0)
  frame.writeUInt8(sof, 1)
  frame.writeUInt16BE(17, 2)
  frame.writeUInt8(8, 4)
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    Buffer.from([0xff, 0xff, 0xd0]),
    frame,
    Buffer.from([0xff, 0xd9])
  ])
}

/**
 * A synthetic clip made with ffmpeg: the moving test pattern at `width` ×
 * `height` and `fps`, `seconds` long, in `codec` (`libx264` or `libx265`),
 * as an MP4, read back as bytes.
 */
export async function syntheticVideo(options: {
  seconds: number
  width: number
  height: number
  fps: number
  codec?: 'libx264' | 'libx265'
  bitRate?: string
  /** The container, by its extension: an MP4 by default. */
  container?: 'mp4' | 'mkv' | 'ts'
}): Promise<Buffer> {
  const container = options.container ?? 'mp4'
  const file = join(
    tmpdir(),
    `sponsor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${container}`
  )
  try {
    await run(TEST_FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${options.width}x${options.height}:rate=${options.fps}:duration=${options.seconds}`,
      '-c:v',
      options.codec ?? 'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      options.bitRate ?? '400k',
      ...(container === 'mp4' ? ['-movflags', '+faststart'] : []),
      ...(options.codec === 'libx265' ? ['-tag:v', 'hvc1'] : []),
      file
    ])
    return await readFile(file)
  } finally {
    await rm(file, { force: true })
  }
}
