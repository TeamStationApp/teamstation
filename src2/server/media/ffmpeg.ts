import { execFile } from 'child_process'
import { promisify } from 'util'

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
  version: string
}

export async function probeFfmpeg(path: string): Promise<FfmpegBuild> {
  const { stdout } = await run(path, ['-version'], { maxBuffer: 1 << 20 })
  const match = /^ffmpeg version (\S+)/.exec(stdout)
  if (match?.[1] == null) {
    throw new Error(`Could not read a version from ${path}`)
  }
  return { path, version: match[1] }
}

/** Throws unless the build on disk is exactly the pinned one. */
export async function assertPinnedFfmpeg(
  path: string,
  expected: string
): Promise<FfmpegBuild> {
  const build = await probeFfmpeg(path)
  if (build.version !== expected) {
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
  /** Directory the playlist and segments are written into. */
  outDir: string
  /** Name of the playlist, without a directory. */
  playlistName?: string
  /** Seconds per segment. Shorter seeks faster and costs more requests. */
  segmentSeconds?: number
}

/**
 * The arguments that turn a recording into HLS without re-encoding it.
 *
 * - `-c copy` is the whole point: no transcode, ever.
 * - `-tag:v hvc1` makes HEVC play in Safari and on Apple hardware. Without it
 *   the track is tagged `hev1` and Safari refuses it.
 * - fMP4 segments, so one file format covers HEVC and H.264 alike.
 * - `-hls_flags temp_file` writes each segment aside and renames it, so a
 *   viewer never fetches a half-written segment during a live stream.
 */
export function remuxToHlsArgs(options: RemuxOptions): string[] {
  const {
    input,
    outDir,
    playlistName = 'master.m3u8',
    segmentSeconds = 6
  } = options
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-c',
    'copy',
    '-tag:v',
    'hvc1',
    '-f',
    'hls',
    '-hls_time',
    String(segmentSeconds),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'temp_file+independent_segments',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    `${outDir}/segment%05d.m4s`,
    `${outDir}/${playlistName}`
  ]
}

export async function remuxToHls(
  ffmpegPath: string,
  options: RemuxOptions
): Promise<void> {
  await run(ffmpegPath, remuxToHlsArgs(options), { maxBuffer: 1 << 22 })
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
