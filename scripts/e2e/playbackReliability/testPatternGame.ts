/**
 * The test-pattern game: four program angles of moving test pattern, shaped
 * like the Distributor's uploads, so a frozen or repeated frame is beyond
 * doubt.
 *
 *   node -r sucrase/register scripts/e2e/playbackReliability/testPatternGame.ts <command> …
 *
 *   encode    --out <dir> --start <iso> [--duration 5630.3] [--only <label>]
 *             Encodes <dir>/<label>.mp4 for each angle.
 *   game-sql  --source <gameId> --game <newGameId> --shift-ms <ms>
 *             The new game: the source game's row under a new id, moved by
 *             the shift. Run before importing, which needs the game.
 *   videos-sql --shift-ms <ms> --pair <tpVideoId>=<sourceVideoId> …
 *             After `npm run import-video`, gives each angle the fields of
 *             the upload it stands in for: codecs, start, clock offset,
 *             source, size, cameras.
 *   structure-sql --source <gameId> --game <gameId> --shift-ms <ms>
 *             --source-live <videoId> --live <newVideoId> --primary <tpVideoId>
 *             TP+: the source game's scoreboard log and plays, and its
 *             replaced live recording with its wall anchors, all moved by
 *             the shift, the recording replaced by the primary angle.
 *   live      --label <label> --url <rtmp-url> [--duration 3600]
 *             Sends one angle of the pattern live, its wall clock from now.
 *   live-game --app <origin> --game <gameId> [--count 1] [--duration 3600]
 *             Signs in (TS_ACCOUNT_*), takes the account's own cameras on
 *             the game for the first <count> angles (adding any missing),
 *             and sends each one live. The keys are never printed.
 *   verify    --app <origin> --pair <tpVideoId>=<sourceVideoId> … [--game <gameId>]
 *             Signs in (TS_ACCOUNT_*) and compares each angle with the
 *             upload it stands in for, and checks the game is the account's
 *             most recent played game.
 *
 * The SQL is printed, not run: where the database is, and how to reach it,
 * is not this repository's business.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { TeamStationClient } from '../../../src/common/api'
import { accountFrom, nodePasswordKdf, passwordOf } from './session'
import { LAYOUT, PATTERN_FPS } from './testPattern'

const run = promisify(execFile)

/** The angles, in the order the source game's uploads are paired with them. */
export const ANGLES = ['Primary', 'Home', '1st', '3rd'] as const

/** The Distributor uploads' length, measured on 2026-10-26. */
export const DURATION_SEC = 5630.3

/** A keyframe every 2 s at 60 fps, as the uploads have. */
export const GOP_FRAMES = 2 * PATTERN_FPS

export interface EncodeOptions {
  label: string
  /** When the recording began: the wall clock burned into it counts from here. */
  startMs: number
  durationSec: number
  /** A file, or an `rtmp://` URL to send the pattern to live. */
  out: string
  fontfile: string
}

/** drawtext's own escaping for text that contains `:` and `\`. */
function drawText(text: string): string {
  return text.replace(/\\/g, '\\\\\\\\').replace(/:/g, '\\:')
}

/**
 * The encoder's arguments. 5 Mbit/s requested lands at about 4 Mbit/s from
 * VideoToolbox on this pattern, which is what the uploads carry; temporal
 * noise makes every frame cost bits and differ from the last.
 */
export function encodeArgs(options: EncodeOptions): string[] {
  const { counter, label, clock } = LAYOUT
  // Live, the pattern goes out at its own pace as FLV, which names HEVC
  // itself and refuses the hvc1 tag a file needs for Safari.
  const live = /^rtmps?:\/\//.test(options.out)
  const font = `fontfile=${options.fontfile}:fontcolor=white`
  const epochSec = (options.startMs / 1000).toFixed(3)
  const filter = [
    'noise=alls=12:allf=t',
    `drawbox=x=iw*${counter.x}:y=ih*${counter.y}:w=iw*${counter.w}:h=ih*${counter.h}:color=black:t=fill`,
    `drawtext=${font}:text='%{eif\\:n\\:d\\:7}':fontsize=h*${(counter.h * 0.8).toFixed(3)}:` +
      `x=w*${counter.x}+(w*${counter.w}-tw)/2:y=h*${counter.y}+(h*${counter.h}-th)/2`,
    `drawtext=${font}:text='${drawText(options.label)}':fontsize=h*${label.size}:` +
      `x=w*${label.x}:y=h*${label.y}:box=1:boxcolor=black@0.6`,
    `drawtext=${font}:text='%{pts\\:hms}   %{pts\\:gmtime\\:${epochSec}\\:%H\\\\\\:%M\\\\\\:%S} Z':` +
      `fontsize=h*${clock.size}:x=w*${clock.x}:y=h*${clock.y}:box=1:boxcolor=black@0.6`,
    'format=yuv420p'
  ].join(',')
  return [
    '-nostdin',
    '-loglevel',
    'error',
    ...(live ? ['-re'] : []),
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1920x1080:rate=${PATTERN_FPS}`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000:beep_factor=4',
    '-t',
    String(options.durationSec),
    '-vf',
    filter,
    '-c:v',
    'hevc_videotoolbox',
    '-profile:v',
    'main',
    ...(live ? ['-realtime', '1'] : ['-tag:v', 'hvc1']),
    '-b:v',
    '5M',
    '-maxrate',
    '5.6M',
    '-bufsize',
    '5.6M',
    '-g',
    String(GOP_FRAMES),
    '-c:a',
    'aac',
    '-b:a',
    '125k',
    '-ac',
    '1',
    ...(live ? ['-f', 'flv'] : ['-y']),
    options.out
  ]
}

/** SQL text for a string literal. */
function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

function interval(shiftMs: number): string {
  if (!Number.isInteger(shiftMs))
    throw new Error('the shift is whole milliseconds')
  return `interval '${shiftMs} milliseconds'`
}

/**
 * The source game's row under a new id, moved by the shift. Copied through
 * JSON so every column comes along without being named here, and a column
 * added later is copied too.
 */
export function gameSql(source: string, game: string, shiftMs: number): string {
  const shift = interval(shiftMs)
  return [
    'begin;',
    'insert into games',
    'select (jsonb_populate_record(null::games, to_jsonb(g) || jsonb_build_object(',
    `  'id', ${literal(game)},`,
    `  'start_at', g.start_at + ${shift},`,
    `  'end_at', g.end_at + ${shift},`,
    `  'lineup_started_at', g.lineup_started_at + ${shift},`,
    `  'schedule_preview_id', null,`,
    `  'created_at', now(), 'updated_at', now()))).*`,
    `from games g where g.id = ${literal(source)};`,
    'commit;'
  ].join('\n')
}

export interface Pair {
  video: string
  source: string
}

export function parsePair(text: string): Pair {
  const [video, source] = text.split('=')
  if (video == null || source == null || video === '' || source === '') {
    throw new Error(`--pair wants <tpVideoId>=<sourceVideoId>, not ${text}`)
  }
  return { video, source }
}

/** Each imported angle takes the fields of the upload it stands in for. */
export function videosSql(pairs: Pair[], shiftMs: number): string {
  const shift = interval(shiftMs)
  return [
    'begin;',
    ...pairs.map(pair =>
      [
        'update videos v set',
        `  codecs = s.codecs, start_at = s.start_at + ${shift},`,
        '  start_at_source = s.start_at_source,',
        '  start_at_clock_offset_ms = s.start_at_clock_offset_ms,',
        '  width = s.width, height = s.height, num_cameras = s.num_cameras,',
        '  updated_at = now()',
        `from videos s where s.id = ${literal(pair.source)} and v.id = ${literal(pair.video)};`
      ].join('\n')
    ),
    'commit;'
  ].join('\n')
}

export interface StructureOptions {
  source: string
  game: string
  shiftMs: number
  sourceLive: string
  live: string
  primary: string
}

/**
 * TP+: what the source game has besides its uploads. Its scoreboard log and
 * its plays, and the live recording the primary upload replaced, kept hidden
 * and carrying its wall anchors, all moved by the shift. Plays get ids of
 * their own, derived from the originals so the SQL can be run once only.
 */
export function structureSql(options: StructureOptions): string {
  const shift = interval(options.shiftMs)
  const source = literal(options.source)
  const game = literal(options.game)
  return [
    'begin;',
    'insert into scoreboard_log (game_id, version, at, cause, actor_id, publisher, overrides, radar)',
    `select ${game}, version, at + ${shift}, cause, actor_id, publisher, overrides, radar`,
    `from scoreboard_log where game_id = ${source};`,
    'insert into events',
    'select (jsonb_populate_record(null::events, to_jsonb(e) || jsonb_build_object(',
    `  'id', 'evt_' || substr(md5(e.id || ${game}), 1, 16),`,
    `  'gameId', ${game},`,
    `  'startTime', e."startTime" + ${shift},`,
    `  'endTime', e."endTime" + ${shift},`,
    `  'createdAt', now(), 'updatedAt', now()))).*`,
    `from events e where e."gameId" = ${source};`,
    'insert into videos',
    'select (jsonb_populate_record(null::videos, to_jsonb(v) || jsonb_build_object(',
    `  'id', ${literal(options.live)},`,
    `  'game_id', ${game},`,
    `  'start_at', v.start_at + ${shift},`,
    `  'published_at', v.published_at + ${shift},`,
    `  'replaced_by', ${literal(options.primary)},`,
    `  'hidden', true,`,
    `  'created_at', now(), 'updated_at', now()))).*`,
    `from videos v where v.id = ${literal(options.sourceLive)};`,
    'insert into video_wall_anchors (video_id, media_ms, wall, source, corrected)',
    `select ${literal(options.live)}, media_ms, wall + ${shift}, source, corrected`,
    `from video_wall_anchors where video_id = ${literal(options.sourceLive)};`,
    'commit;'
  ].join('\n')
}

/** What a media playlist says about its segments. */
export interface PlaylistShape {
  segments: number
  durationSec: number
  /** Byte sizes of the segments, in order. */
  sizes: number[]
  /** The init section and the first segment, as one byte range from 0. */
  headBytes: number
  firstUrl: string | null
}

export function playlistShape(text: string): PlaylistShape {
  const lines = text.split('\n').map(line => line.trim())
  let durationSec = 0
  const sizes: number[] = []
  let firstUrl: string | null = null
  let headBytes = 0
  lines.forEach((line, index) => {
    const extinf = /^#EXTINF:([0-9.]+)/.exec(line)
    if (extinf != null) durationSec += Number(extinf[1])
    const range = /^#EXT-X-BYTERANGE:(\d+)@(\d+)/.exec(line)
    if (range != null) {
      sizes.push(Number(range[1]))
      if (sizes.length === 1) {
        headBytes = Number(range[1]) + Number(range[2])
        firstUrl = lines[index + 1] ?? null
      }
    }
  })
  return { segments: sizes.length, durationSec, sizes, headBytes, firstUrl }
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/** What ffprobe reads from the head of a stream. */
export interface StreamShape {
  codecTag: string
  fps: number
  /** Seconds between keyframes. */
  keyframeSec: number | null
}

export function streamShape(
  probeJson: string,
  keyframeTimes: number[]
): StreamShape {
  const stream = (
    JSON.parse(probeJson) as {
      streams?: Array<{ codec_tag_string?: string; r_frame_rate?: string }>
    }
  ).streams?.[0]
  const [numerator, denominator] = (stream?.r_frame_rate ?? '0/1')
    .split('/')
    .map(Number)
  const gaps = keyframeTimes
    .slice(1)
    .map((time, index) => time - keyframeTimes[index])
  return {
    codecTag: stream?.codec_tag_string ?? '',
    fps: denominator > 0 ? numerator / denominator : 0,
    keyframeSec: gaps.length === 0 ? null : Math.round(median(gaps) * 100) / 100
  }
}

export interface AngleShape {
  playlist: PlaylistShape
  stream: StreamShape
}

/** Each way a test angle differs from the upload it stands in for. */
export function compareShapes(test: AngleShape, upload: AngleShape): string[] {
  const problems: string[] = []
  if (test.stream.codecTag !== upload.stream.codecTag) {
    problems.push(`codec ${test.stream.codecTag} ≠ ${upload.stream.codecTag}`)
  }
  if (test.stream.fps !== upload.stream.fps) {
    problems.push(`${test.stream.fps} fps ≠ ${upload.stream.fps} fps`)
  }
  if (test.stream.keyframeSec !== upload.stream.keyframeSec) {
    problems.push(
      `keyframes every ${test.stream.keyframeSec} s ≠ ${upload.stream.keyframeSec} s`
    )
  }
  if (test.playlist.segments !== upload.playlist.segments) {
    problems.push(
      `${test.playlist.segments} segments ≠ ${upload.playlist.segments}`
    )
  }
  if (Math.abs(test.playlist.durationSec - upload.playlist.durationSec) > 1) {
    problems.push(
      `${test.playlist.durationSec.toFixed(1)} s ≠ ${upload.playlist.durationSec.toFixed(1)} s`
    )
  }
  const testSize = median(test.playlist.sizes)
  const uploadSize = median(upload.playlist.sizes)
  if (uploadSize > 0 && Math.abs(testSize - uploadSize) / uploadSize > 0.15) {
    problems.push(
      `median segment ${testSize} bytes is not within 15 % of ${uploadSize}`
    )
  }
  return problems
}

/** Reads an angle's playlists and the head of its stream, through the signed URLs the server hands out. */
export async function angleShape(
  client: Pick<TeamStationClient, 'playback'>,
  videoId: string,
  tools: {
    fetch: typeof fetch
    ffprobe: (args: string[]) => Promise<string>
    scratch: string
  }
): Promise<AngleShape> {
  const master = (await client.playback(videoId)).url
  if (master == null) throw new Error(`${videoId}: no master playlist`)
  const masterText = await (await tools.fetch(master)).text()
  const media = masterText.split('\n').find(line => line.startsWith('http'))
  if (media == null) throw new Error(`${videoId}: no media playlist`)
  const playlist = playlistShape(await (await tools.fetch(media)).text())
  if (playlist.firstUrl == null) throw new Error(`${videoId}: no segments`)
  const head = await tools.fetch(playlist.firstUrl, {
    headers: { Range: `bytes=0-${playlist.headBytes * 3 - 1}` }
  })
  const file = join(tools.scratch, `${videoId}.mp4`)
  await writeFile(file, Buffer.from(await head.arrayBuffer()))
  const probe = await tools.ffprobe([
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_tag_string,r_frame_rate',
    '-of',
    'json',
    file
  ])
  const keyframes = await tools.ffprobe([
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-skip_frame',
    'nokey',
    '-show_entries',
    'frame=pts_time',
    '-of',
    'csv=p=0',
    file
  ])
  const times = keyframes
    .split('\n')
    .map(text => text.trim().replace(/,$/, ''))
    .filter(text => text !== '' && text !== 'N/A')
    .map(Number)
  return { playlist, stream: streamShape(probe, times) }
}

function option(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}

function required(argv: string[], name: string): string {
  const value = option(argv, name)
  if (value == null) throw new Error(`--${name} is required`)
  return value
}

function all(argv: string[], name: string): string[] {
  return argv.flatMap((arg, index) =>
    arg === `--${name}` ? [argv[index + 1]] : []
  )
}

export interface Io {
  log: (line: string) => void
  run: (program: string, args: string[]) => Promise<string>
  fetch: typeof fetch
  env: Record<string, string | undefined>
}

const defaultIo: Io = {
  log: line => {
    console.log(line)
  },
  run: async (program, args) =>
    (await run(program, args, { maxBuffer: 1 << 26 })).stdout,
  fetch,
  env: process.env
}

/** An address with any RTMP URL in it, which carries a stream key, cut out. */
export function withoutKeys(text: string): string {
  return text.replace(/rtmps?:\/\/\S+/g, 'rtmp://…')
}

/**
 * Sends one angle live. A sender that fails is named by its angle: ffmpeg's
 * failure repeats its whole command line, URL and stream key with it, and
 * that must not reach a log.
 */
async function send(io: Io, label: string, args: string[]): Promise<void> {
  try {
    await io.run(io.env.FFMPEG_PATH ?? 'ffmpeg', args)
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: ${withoutKeys(text)}`)
  }
}

/** A client signed in as the TS_ACCOUNT_* account, its password from 1Password. */
async function signedIn(app: string, io: Io): Promise<TeamStationClient> {
  const baseUrl = `${app.replace(/\/+$/, '')}/api/v1`
  const account = accountFrom(io.env)
  const signIn = new TeamStationClient({
    baseUrl,
    passwordKdf: nodePasswordKdf,
    fetch: io.fetch
  })
  const password = await passwordOf(account, async (program, args) => ({
    stdout: await io.run(program, args)
  }))
  const session = await signIn.signInWithPassword(account.email, password)
  return new TeamStationClient({
    baseUrl,
    token: session.token,
    fetch: io.fetch
  })
}

export async function main(
  argv: string[],
  io: Io = defaultIo
): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'encode': {
      const out = required(rest, 'out')
      const startMs = Date.parse(required(rest, 'start'))
      if (Number.isNaN(startMs)) throw new Error('--start is not a time')
      const durationSec = Number(option(rest, 'duration') ?? DURATION_SEC)
      const only = option(rest, 'only')
      const fontfile =
        io.env.TS_PATTERN_FONT ?? '/System/Library/Fonts/Menlo.ttc'
      for (const label of ANGLES.filter(one => only == null || one === only)) {
        const file = join(out, `${label}.mp4`)
        io.log(`encoding ${file}`)
        await io.run(
          io.env.FFMPEG_PATH ?? 'ffmpeg',
          encodeArgs({ label, startMs, durationSec, out: file, fontfile })
        )
      }
      return 0
    }
    case 'live': {
      // One angle sent live: its label, and the wall clock from now.
      const fontfile =
        io.env.TS_PATTERN_FONT ?? '/System/Library/Fonts/Menlo.ttc'
      const args = encodeArgs({
        label: required(rest, 'label'),
        startMs: Date.now(),
        durationSec: Number(option(rest, 'duration') ?? 3600),
        out: required(rest, 'url'),
        fontfile
      })
      io.log(`sending ${required(rest, 'label')}`)
      await send(io, required(rest, 'label'), args)
      return 0
    }
    case 'game-sql':
      io.log(
        gameSql(
          required(rest, 'source'),
          required(rest, 'game'),
          Number(required(rest, 'shift-ms'))
        )
      )
      return 0
    case 'videos-sql':
      io.log(
        videosSql(
          all(rest, 'pair').map(parsePair),
          Number(required(rest, 'shift-ms'))
        )
      )
      return 0
    case 'structure-sql':
      io.log(
        structureSql({
          source: required(rest, 'source'),
          game: required(rest, 'game'),
          shiftMs: Number(required(rest, 'shift-ms')),
          sourceLive: required(rest, 'source-live'),
          live: required(rest, 'live'),
          primary: required(rest, 'primary')
        })
      )
      return 0
    case 'live-game': {
      const client = await signedIn(required(rest, 'app'), io)
      const game = required(rest, 'game')
      const count = Number(option(rest, 'count') ?? 1)
      const durationSec = Number(option(rest, 'duration') ?? 3600)
      const fontfile =
        io.env.TS_PATTERN_FONT ?? '/System/Library/Fonts/Menlo.ttc'
      const { mine } = await client.liveStreams(game)
      const urls: string[] = []
      for (const label of ANGLES.slice(0, count)) {
        const held = mine.find(
          stream => stream.label === label && stream.closesAt == null
        )
        const stream =
          held == null
            ? await client.addLiveStream(game, label)
            : await client.revealLiveStream(game, held.id)
        if (stream.url == null) throw new Error(`no URL for ${label}`)
        urls.push(stream.url)
      }
      io.log(`sending ${ANGLES.slice(0, count).join(', ')} to ${game}`)
      const startMs = Date.now()
      await Promise.all(
        urls.map(async (out, index) => {
          await send(
            io,
            ANGLES[index],
            encodeArgs({
              label: ANGLES[index],
              startMs,
              durationSec,
              out,
              fontfile
            })
          )
        })
      )
      return 0
    }
    case 'verify': {
      const client = await signedIn(required(rest, 'app'), io)
      const scratch = await mkdtemp(join(tmpdir(), 'pbr-verify-'))
      let failures = 0
      try {
        const tools = {
          fetch: io.fetch,
          ffprobe: async (args: string[]) =>
            await io.run(io.env.FFPROBE_PATH ?? 'ffprobe', args),
          scratch
        }
        for (const pair of all(rest, 'pair').map(parsePair)) {
          const problems = compareShapes(
            await angleShape(client, pair.video, tools),
            await angleShape(client, pair.source, tools)
          )
          failures += problems.length
          io.log(
            `${pair.video} vs ${pair.source}: ${problems.length === 0 ? 'match' : problems.join('; ')}`
          )
        }
        const game = option(rest, 'game')
        if (game != null) {
          const recent = await client.recentGame()
          const first = recent?.id === game
          if (!first) failures++
          io.log(
            `most recent played game: ${recent?.id ?? 'none'}${first ? ' (the test game)' : ` (not ${game})`}`
          )
        }
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
      return failures === 0 ? 0 : 1
    }
    default:
      throw new Error(
        'commands: encode, live, live-game, game-sql, videos-sql, structure-sql, verify'
      )
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => {
      process.exit(code)
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  )
}
