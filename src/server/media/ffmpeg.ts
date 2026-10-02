import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { execFile } from 'child_process'
import { promisify } from 'util'

import { codecsAttribute, codecsFromInit } from './codecString'

const run = promisify(execFile)

/**
 * The server never transcodes. Everything here copies streams and rewrites the
 * container, so the picture that reaches a viewer is the one the camera made.
 *
 * The build is pinned because these flags are version-sensitive: FFmpeg 9.0.1
 * is the one whose HEVC-in-fMP4 output was tested here, and an older build
 * writes a different `hvcC` and a different playlist.
 */
export interface FfmpegBuild {
  path: string
  /** Exactly what the build reports, e.g. `n9.0.1-30-g9258bacca5-20260915`. */
  version: string
  /** The upstream release inside it, e.g. `9.0.1`. */
  release: string
}

export async function probeFfmpeg(path: string): Promise<FfmpegBuild> {
  const { stdout } = await run(path, ['-version'], { maxBuffer: 1 << 20 })
  const match = /^ffmpeg version (\S+)/.exec(stdout)
  if (match?.[1] == null) {
    throw new Error(`Could not read a version from ${path}`)
  }
  return { path, version: match[1], release: releaseOf(match[1]) }
}

/**
 * The upstream release inside a build's version string.
 *
 * A distribution reports `9.0.1`, while the pinned static build reports
 * `n9.0.1-30-g9258bacca5-20260915`: the same FFmpeg, plus the commits since
 * the tag and the build date. The integrity pin is the sha256 in
 * `ffmpeg.json`; this is what decides whether the *release* is the one the
 * contract suite was written against.
 */
export function releaseOf(version: string): string {
  const match = /^n?(\d+\.\d+(?:\.\d+)?)/.exec(version)
  return match?.[1] ?? version
}

/** Throws unless the build on disk is exactly the pinned one. */
export async function assertPinnedFfmpeg(
  path: string,
  expected: string
): Promise<FfmpegBuild> {
  const build = await probeFfmpeg(path)
  if (build.release !== releaseOf(expected)) {
    throw new Error(
      `FFmpeg at ${path} is ${build.version}, but this server is pinned to ${expected}`
    )
  }
  return build
}

/** Which codecs a build can actually encode, for the contract tests. */
export async function ffmpegEncoders(path: string): Promise<Set<string>> {
  const { stdout } = await run(path, ['-hide_banner', '-encoders'], {
    maxBuffer: 1 << 22
  })
  const names = new Set<string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s[A-Z.]{6}\s(\S+)/.exec(line)
    if (match?.[1] != null) names.add(match[1])
  }
  return names
}

export interface RemuxOptions {
  input: string
  /** Directory the playlist and the video file are written into. */
  outDir: string
  /** Seconds per segment. Shorter seeks faster and costs more requests. */
  segmentSeconds?: number
  /**
   * What to tag the video track as, or null to leave it alone.
   *
   * `hvc1` by default, because everything this server records is HEVC and
   * Safari refuses an HEVC track tagged `hev1`. It is **wrong for anything
   * else**: a recording from a camera that shoots H.264 must keep `avc1`, and
   * a stream tagged as a codec it is not plays nowhere at all.
   */
  videoTag?: string | null
}

/** What the remux writes, and what everything downstream expects to find. */
export const MASTER_PLAYLIST = 'master.m3u8'
export const MEDIA_PLAYLIST = 'video.m3u8'
export const VIDEO_FILE = 'video.mp4'

/**
 * The arguments that turn a recording into HLS without re-encoding it.
 *
 * - `-c copy` is the whole point: no transcode, ever.
 * - `-tag:v hvc1` makes HEVC play in Safari and on Apple hardware. Without it
 *   the track is tagged `hev1` and Safari refuses it.
 * - fMP4, so one file format covers HEVC and H.264 alike.
 * - `single_file` writes **one** fragmented MP4 with a byte-range playlist,
 *   the shape PeerTube already uses. It is what lets a video in the Space
 *   need one presigned URL instead of one per segment, and it is what lets a
 *   still be taken by seeking inside a single file.
 *
 * `temp_file` is deliberately absent. It is for live, where a viewer must not
 * fetch a half-written segment — and combined with `single_file` it writes the
 * *temporary* name into the playlist, leaving every entry pointing at a
 * `video.mp4.tmp` that is renamed away the moment the remux finishes.
 */
export function remuxToHlsArgs(options: RemuxOptions): string[] {
  const { input, outDir, segmentSeconds = 6, videoTag = 'hvc1' } = options
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-c',
    'copy',
    ...(videoTag == null ? [] : ['-tag:v', videoTag]),
    '-f',
    'hls',
    '-hls_time',
    String(segmentSeconds),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'single_file+independent_segments',
    '-hls_segment_filename',
    `${outDir}/${VIDEO_FILE}`,
    '-master_pl_name',
    MASTER_PLAYLIST,
    `${outDir}/${MEDIA_PLAYLIST}`
  ]
}

export async function remuxToHls(
  ffmpegPath: string,
  options: RemuxOptions
): Promise<void> {
  await run(ffmpegPath, remuxToHlsArgs(options), { maxBuffer: 1 << 22 })
  await addCodecsToMaster(options.outDir)
}

/**
 * Puts the real `CODECS` into the master playlist.
 *
 * FFmpeg writes BANDWIDTH and RESOLUTION but no CODECS when it is only copying
 * streams, because it never parses the extradata it passes through. Safari
 * decides whether to attempt an HEVC stream from that attribute, so the value
 * is read out of the file itself and inserted into the line FFmpeg wrote,
 * leaving its own measurements alone.
 */
export async function addCodecsToMaster(outDir: string): Promise<void> {
  const masterPath = join(outDir, MASTER_PLAYLIST)
  const [master, head] = await Promise.all([
    readFile(masterPath, 'utf8'),
    readInitBytes(join(outDir, VIDEO_FILE))
  ])

  const codecs = codecsAttribute(codecsFromInit(head))
  if (codecs === '') return

  const updated = master.replace(
    /^#EXT-X-STREAM-INF:(?!.*CODECS=)(.*)$/m,
    (line, attributes: string) =>
      `#EXT-X-STREAM-INF:${attributes},CODECS="${codecs}"`
  )
  if (updated !== master) await writeFile(masterPath, updated)
}

/**
 * The start of the file, which is where the init segment is in fMP4 — enough
 * to hold the `moov` any remux of ours produces, without reading a file that
 * may be gigabytes.
 */
async function readInitBytes(path: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export interface ProbedStream {
  codecName: string
  codecTag: string
  width?: number
  height?: number
}

/** Reads back what a file actually contains, for verification after a remux. */
export async function probeVideoStream(
  ffprobePath: string,
  file: string
): Promise<ProbedStream> {
  const { stdout } = await run(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,codec_tag_string,width,height',
      '-of',
      'json',
      file
    ],
    { maxBuffer: 1 << 22 }
  )
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_name?: string
      codec_tag_string?: string
      width?: number
      height?: number
    }>
  }
  const stream = parsed.streams?.[0]
  if (stream?.codec_name == null) {
    throw new Error(`No video stream in ${file}`)
  }
  return {
    codecName: stream.codec_name,
    codecTag: stream.codec_tag_string ?? '',
    width: stream.width,
    height: stream.height
  }
}

/**
 * How long a finished recording runs, read from the file rather than counted.
 *
 * Asked of a live stream's playlist after it has been closed, where the answer
 * is the sum of its segments and nothing on the row knows it yet. A playlist
 * still being written has no honest duration, so this is only ever called once
 * the `EXT-X-ENDLIST` is there.
 */
export async function probeDuration(
  ffprobePath: string,
  file: string
): Promise<number> {
  const { stdout } = await run(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      file
    ],
    { maxBuffer: 1 << 20 }
  )
  const seconds = Number.parseFloat(stdout.trim())
  if (!Number.isFinite(seconds)) throw new Error(`No duration in ${file}`)
  return seconds
}

/** The ffprobe beside a given ffmpeg. They are shipped and pinned together. */
export function ffprobeFor(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')
}
