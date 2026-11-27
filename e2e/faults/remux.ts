import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { ffprobeFor, remuxToHls } from '../../src/server/media/ffmpeg'
import { putObjectFile } from '../../src/server/media/images'
import type { SpaceSettings } from '../../src/server/media/spacesHls'
import {
  contentTypeFor,
  listSpaceObjectEntries
} from '../../src/server/media/spacesVideo'
import type { StackDatabase } from './database'
import type { PagesStandIn } from './pages'

/**
 * The fault server's `remux` route: the media work a recording scenario
 * needs done where the stack's API, database and Space are, so a test never
 * reaches the droplet, its database or its Space keys itself
 * (`e2e/rigs/media/stackSpace.ts` is its client).
 *
 *   POST /__e2e/remux { action, ... }
 *
 *   programme   { seconds, path }      HEVC with sound, keyed every 2 s,
 *                                      served on the pages stand-in at path
 *                                      → { path, bytes }
 *   single-file { videoId, gameId, title, startAt, seconds }
 *                                      a programme remuxed to one video.mp4,
 *                                      put under videos/<videoId>/, and its
 *                                      row → { videoId }
 *   segment     { args }               `node lib/server/dev/segmentSpaceVideos.js
 *                                      <args>` in the checkout → { output }
 *   objects     { prefix }             the Space's objects → { objects }
 *   play        { gameId, battingTeamId, videoId, secondsIn, atBatIndex }
 *                                      a play that far into the video's own
 *                                      clock → { eventId }
 *   machine     {}                     this machine → { vcpus, memGiB }
 *   take        { seconds, path }      a short video-only H.264 take with no
 *                                      B-frames, as Director's upload client
 *                                      sends one, served on the pages stand-in
 *                                      at path, and what ffprobe reads of it
 *                                      → { path, bytes, streams, firstDts }
 *
 * `broadcast.ts` adds the fake broadcaster's actions (`more`).
 */
export class RemuxError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export type RemuxHandler = (body: unknown) => Promise<unknown>

/** More actions beside these, by name (`broadcast.ts`'s). */
export type RemuxActions = Record<
  string,
  (body: Record<string, unknown>) => Promise<unknown>
>

export interface RemuxDeps {
  /** The checkout the server runs from, which holds the built `lib/`. */
  checkout: string
  /** Where programmes are made; they stay while the server serves them. */
  scratch: string
  database?: StackDatabase
  pages: PagesStandIn
  /** The stack's Space and FFmpeg, from its server config, read when asked. */
  config: () => { space?: SpaceSettings; ffmpegPath?: string }
  run: (
    file: string,
    args: string[],
    options: { cwd?: string }
  ) => Promise<{ stdout: string }>
  remux: typeof remuxToHls
  put: typeof putObjectFile
  list: typeof listSpaceObjectEntries
  machine: () => { vcpus: number; memGiB: number }
  makeId: () => string
  /** Actions of other modules the route also answers. */
  more?: RemuxActions
}

/** The test programme: a moving pattern and a tone, as a take is encoded. */
export function programmeArgs(seconds: number, file: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    String(seconds),
    '-c:v',
    'libx265',
    '-preset',
    'ultrafast',
    '-x265-params',
    'log-level=none:keyint=60',
    '-tag:v',
    'hvc1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file
  ]
}

/** A take as Director's upload client sends one: H.264, no B-frames, no sound. */
export function takeArgs(seconds: number, file: string): string[] {
  return [
    ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi'],
    ...['-i', `testsrc2=size=320x180:rate=30:duration=${seconds}`],
    ...['-c:v', 'libx264', '-bf', '0', '-an', file]
  ]
}

/** ffprobe's arguments for a file's streams and its first packets' decode times. */
export function probeArgs(file: string): string[] {
  return [
    ...['-v', 'error', '-read_intervals', '%+#4'],
    ...['-show_entries', 'packet=dts_time:stream=codec_name,codec_type'],
    ...['-of', 'json', file]
  ]
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const PATH = /^\/[A-Za-z0-9._/-]{1,200}$/
const MAX_SECONDS = 3600

function bad(message: string): never {
  throw new RemuxError(400, message)
}

function text(body: Record<string, unknown>, name: string, shape = ID): string {
  const value = body[name]
  if (typeof value !== 'string' || !shape.test(value)) {
    bad(`${name} is not a valid ${name}`)
  }
  return value
}

function count(
  body: Record<string, unknown>,
  name: string,
  max: number
): number {
  const value = body[name]
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  ) {
    bad(`${name} is a whole number, 0 to ${max}`)
  }
  return value
}

/** The route's handler over `deps`. */
export function remuxActions(deps: RemuxDeps): RemuxHandler {
  const ffmpeg = (): string => deps.config().ffmpegPath ?? 'ffmpeg'
  const space = (): SpaceSettings => {
    const found = deps.config().space
    if (found?.bucket == null || found.bucket === '') {
      throw new RemuxError(501, 'the stack has no Space configured')
    }
    return found
  }
  const database = (): StackDatabase => {
    if (deps.database == null) {
      throw new RemuxError(
        501,
        'this fault server has no database: start it with DATABASE_URL'
      )
    }
    return deps.database
  }
  const encode = async (seconds: number, dir: string): Promise<string> => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'programme.mp4')
    await deps.run(ffmpeg(), programmeArgs(seconds, file), {})
    return file
  }

  const actions: Record<
    string,
    (body: Record<string, unknown>) => Promise<unknown>
  > = {
    programme: async body => {
      const seconds = count(body, 'seconds', MAX_SECONDS)
      const path = text(body, 'path', PATH)
      const file = await encode(
        seconds,
        mkdtempSync(join(deps.scratch, 'programme-'))
      )
      deps.pages.serveFile(path, file, 'video/mp4')
      return { path, bytes: statSync(file).size }
    },

    'single-file': async body => {
      const videoId = text(body, 'videoId')
      const gameId = text(body, 'gameId')
      const seconds = count(body, 'seconds', MAX_SECONDS)
      const title = body.title
      if (typeof title !== 'string' || title === '') bad('title is a title')
      const startAt = new Date(String(body.startAt))
      if (Number.isNaN(startAt.getTime())) bad('startAt is a time')
      const target = space()
      const db = database()
      const dir = mkdtempSync(join(deps.scratch, 'single-'))
      try {
        const source = await encode(seconds, join(dir, 'source'))
        const out = join(dir, 'single')
        mkdirSync(out, { recursive: true })
        await deps.remux(ffmpeg(), {
          input: source,
          outDir: out,
          layout: 'single-file'
        })
        for (const name of ['master.m3u8', 'video.m3u8', 'video.mp4']) {
          await deps.put({
            space: target,
            key: `videos/${videoId}/${name}`,
            path: join(out, name),
            contentType: contentTypeFor(name)
          })
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      await db.query(
        `INSERT INTO videos (id, game_id, kind, title, storage, status, start_at,
           start_at_source, duration_sec, codecs, width, height, spaces_verified_at)
         VALUES ($1, $2, 'program', $3, 'spaces', 'ready', $4, 'manual', $5,
           'hvc1', 1280, 720, now())`,
        [videoId, gameId, title, startAt.toISOString(), seconds]
      )
      return { videoId }
    },

    segment: async body => {
      const args = body.args
      if (
        !Array.isArray(args) ||
        args.some(
          arg =>
            typeof arg !== 'string' || !/^[A-Za-z0-9_=.-]{1,100}$/.test(arg)
        )
      ) {
        bad('args are the script’s arguments')
      }
      const { stdout } = await deps.run(
        process.execPath,
        ['lib/server/dev/segmentSpaceVideos.js', ...(args as string[])],
        { cwd: deps.checkout }
      )
      return { output: stdout }
    },

    objects: async body => {
      const prefix = text(body, 'prefix', /^[A-Za-z0-9._/-]{1,200}$/)
      const entries = await deps.list(space(), prefix)
      return { objects: entries.map(({ key, size }) => ({ key, size })) }
    },

    play: async body => {
      const gameId = text(body, 'gameId')
      const battingTeamId = text(body, 'battingTeamId')
      const videoId = text(body, 'videoId')
      const secondsIn = count(body, 'secondsIn', 24 * 3600)
      const atBatIndex = count(body, 'atBatIndex', 10_000)
      const db = database()
      const video = await db.query(
        'SELECT start_at FROM videos WHERE id = $1',
        [videoId]
      )
      const startAt = video.rows[0]?.start_at
      if (startAt == null) {
        throw new RemuxError(404, `video ${videoId} has no start`)
      }
      const at = new Date(
        new Date(startAt as string).getTime() + secondsIn * 1000
      ).toISOString()
      const id = `evt_seek${deps.makeId()}`
      const gumbo = {
        about: {
          atBatIndex,
          inning: 1,
          halfInning: 'top',
          isScoringPlay: false,
          startTime: at
        },
        result: { eventType: 'double', awayScore: 0, homeScore: 0 }
      }
      await db.query(
        'INSERT INTO events (id, "gameId", "startTime", "battingTeamId", gumbo) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [id, gameId, at, battingTeamId, JSON.stringify(gumbo)]
      )
      return { eventId: id }
    },

    machine: async () => deps.machine(),

    take: async body => {
      const seconds = count(body, 'seconds', 60)
      if (seconds === 0) bad('seconds is a whole number, 1 to 60')
      const path = text(body, 'path', PATH)
      const file = join(mkdtempSync(join(deps.scratch, 'take-')), 'take.mp4')
      await deps.run(ffmpeg(), takeArgs(seconds, file), {})
      const { stdout } = await deps.run(
        ffprobeFor(ffmpeg()),
        probeArgs(file),
        {}
      )
      const probed = JSON.parse(stdout) as {
        streams?: Array<{ codec_type: string; codec_name: string }>
        packets?: Array<{ dts_time?: string }>
      }
      const dts = probed.packets?.[0]?.dts_time
      deps.pages.serveFile(path, file, 'video/mp4')
      return {
        path,
        bytes: statSync(file).size,
        streams: (probed.streams ?? []).map(
          one => `${one.codec_type}/${one.codec_name}`
        ),
        firstDts: dts == null ? null : Number(dts)
      }
    },

    ...deps.more
  }

  return async body => {
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      bad('the body is { action, ... }')
    }
    const { action, ...rest } = body as Record<string, unknown>
    const act = typeof action === 'string' ? actions[action] : undefined
    if (act == null) {
      bad(`action is one of ${Object.keys(actions).join(', ')}`)
    }
    return await act(rest)
  }
}

const execFileAsync = promisify(execFile)

/** The checkout's own server config, as the stack's API reads it. */
export function stackServerConfig(checkout: string): {
  space?: SpaceSettings
  ffmpegPath?: string
  mediaDir?: string
  live?: Record<string, unknown>
} {
  return JSON.parse(
    readFileSync(join(checkout, 'serverConfig.json'), 'utf8')
  ) as ReturnType<typeof stackServerConfig>
}

/** The handler a stack's fault server runs, on its own checkout, database and pages. */
export function stackRemux(
  checkout: string,
  database: StackDatabase | undefined,
  pages: PagesStandIn,
  more?: RemuxActions
): RemuxHandler {
  return remuxActions({
    ...(more == null ? {} : { more }),
    checkout,
    scratch: mkdtempSync(join(tmpdir(), 'e2e-remux-')),
    ...(database == null ? {} : { database }),
    pages,
    config: () => stackServerConfig(checkout),
    run: async (file, args, options) =>
      await execFileAsync(file, args, {
        ...options,
        maxBuffer: 1 << 26,
        timeout: 1_200_000
      }),
    remux: remuxToHls,
    put: putObjectFile,
    list: listSpaceObjectEntries,
    machine: () => ({
      vcpus: cpus().length,
      memGiB: Math.round(totalmem() / 2 ** 30)
    }),
    makeId: () => Math.random().toString(36).slice(2, 10)
  })
}
