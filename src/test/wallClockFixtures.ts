import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { ffmpegEncoders, KEEP_STREAM_TIMES } from '../server/media/ffmpeg'
import { stampWallClock } from '../server/media/wallClockStamp'

/**
 * Real video for the wall-clock suites, made with the local FFmpeg: a
 * fragmented MP4 as a camera's would be, stamped or not, and live HLS written
 * the way the splitter writes it, outage and all.
 */
const run = promisify(execFile)
export const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

/** Whether this machine's FFmpeg can make the fixtures at all. */
export async function canEncode(...encoders: string[]): Promise<boolean> {
  try {
    const have = await ffmpegEncoders(FFMPEG)
    return encoders.every(name => have.has(name))
  } catch {
    return false
  }
}

/**
 * `seconds` of a test picture at 30 frames a second, a keyframe a second,
 * as a fragmented MP4. `bframes` above zero gives a track whose presentation
 * runs ahead of its decoding.
 */
export async function encodeFragmented(
  out: string,
  options: {
    codec: 'hevc' | 'h264'
    seconds: number
    bframes?: number
    sound?: boolean
    /** FFmpeg's `-movflags`, for a file laid out some other way. */
    movflags?: string
  }
): Promise<void> {
  const bframes = options.bframes ?? 0
  const video =
    options.codec === 'hevc'
      ? [
          '-c:v',
          'libx265',
          '-x265-params',
          `log-level=none:keyint=30:min-keyint=30:bframes=${bframes}`,
          '-tag:v',
          'hvc1'
        ]
      : ['-c:v', 'libx264', '-g', '30', '-bf', String(bframes)]
  await run(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=160x120:rate=30:duration=${options.seconds}`,
      ...(options.sound === true
        ? [
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=1000:sample_rate=48000:duration=${options.seconds}`,
            '-c:a',
            'aac'
          ]
        : []),
      ...video,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      options.movflags ?? 'frag_keyframe+empty_moov+default_base_moof',
      out
    ],
    { maxBuffer: 1 << 22 }
  )
}

/** A copy of `input` with every frame stamped from `startWallMs`. */
export async function stampFile(
  input: string,
  out: string,
  startWallMs: number,
  corrected = true
): Promise<void> {
  await writeFile(
    out,
    stampWallClock(await readFile(input), startWallMs, corrected)
  )
}

/**
 * Writes `input` from `fromSec` for `seconds` into `dir` as the splitter's
 * HLS leg does: `-c copy`, fMP4 segments of a second under temporary names,
 * and, for a writer after the first, appended to the playlist behind a
 * discontinuity. The input's timestamps start again from zero, as a
 * reconnected publisher's do.
 */
export async function writeLive(
  input: string,
  dir: string,
  options: { fromSec?: number; seconds?: number; startNumber?: number }
): Promise<void> {
  const flags = ['independent_segments', 'temp_file']
  if ((options.startNumber ?? 0) > 0) flags.push('append_list', 'discont_start')
  await run(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...(options.fromSec == null ? [] : ['-ss', String(options.fromSec)]),
      '-i',
      input,
      ...(options.seconds == null ? [] : ['-t', String(options.seconds)]),
      '-c',
      'copy',
      '-tag:v',
      'hvc1',
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_playlist_type',
      'event',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      'init.mp4',
      ...KEEP_STREAM_TIMES,
      '-hls_flags',
      flags.join('+'),
      '-start_number',
      String(options.startNumber ?? 0),
      '-hls_segment_filename',
      join(dir, 'seg%06d.m4s'),
      join(dir, 'master.m3u8')
    ],
    { maxBuffer: 1 << 22 }
  )
  // A publisher that is coming back has not ended the stream.
  const path = join(dir, 'master.m3u8')
  const playlist = await readFile(path, 'utf8')
  await writeFile(path, playlist.replace('#EXT-X-ENDLIST\n', ''))
}
