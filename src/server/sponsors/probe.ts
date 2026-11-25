import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { badRequest } from '../../common/errors'
import type { VideoProbe } from '../../common/sponsors/limits'
import { ffprobeFor } from '../media/ffmpeg'

const run = promisify(execFile)

/** What the screen says of a file ffprobe cannot read as a video. */
export const UNREADABLE_VIDEO =
  'This video could not be read. Try another file.'

/** `30000/1001` as 29.97…; `0/0` (no rate) as 0. */
function rate(fraction: unknown): number {
  const text = typeof fraction === 'string' ? fraction : ''
  const [num, den] = text.split('/').map(Number)
  if (den == null) return Number.isFinite(num) ? num : 0
  return den > 0 && Number.isFinite(num) ? num / den : 0
}

/**
 * ffprobe's JSON for the first video stream and the format, as the checks
 * read it, or `null` when it names no video stream.
 */
export function readVideoProbe(stdout: string): VideoProbe | null {
  let parsed: {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const stream = parsed.streams?.[0]
  if (stream == null || typeof stream.codec_name !== 'string') return null
  const number = (value: unknown): number => {
    const read = Number(value)
    return Number.isFinite(read) ? read : 0
  }
  return {
    codec: stream.codec_name,
    width: number(stream.width),
    height: number(stream.height),
    fps: rate(stream.avg_frame_rate),
    durationSec: number(parsed.format?.duration),
    bitRate: number(parsed.format?.bit_rate)
  }
}

/**
 * What the pinned ffprobe says of `file`'s video. The server only reads it:
 * nothing is transcoded, resized or re-encoded. A file it cannot read is a
 * 400 with the screen's sentence.
 */
export async function probeSponsorVideo(
  ffmpegPath: string,
  file: string
): Promise<VideoProbe> {
  let stdout: string
  try {
    ;({ stdout } = await run(
      ffprobeFor(ffmpegPath),
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height,avg_frame_rate:format=duration,bit_rate',
        '-of',
        'json',
        file
      ],
      { maxBuffer: 1 << 20, timeout: 30_000 }
    ))
  } catch {
    throw badRequest(UNREADABLE_VIDEO)
  }
  const probe = readVideoProbe(stdout)
  if (probe == null) throw badRequest(UNREADABLE_VIDEO)
  return probe
}
