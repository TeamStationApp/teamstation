import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

import { liveVideoDir } from '../../src/server/live/controller'
import { RemuxError } from './remux'

/**
 * The fake broadcaster on the stack: a camera publishing into the stack's own
 * ingest, so a playback scenario reaches its live streams and recordings as a
 * viewer does, and this machine encodes and publishes nothing. These are
 * actions of the fault server's `remux` route (`remux.ts`), and
 * `e2e/rigs/media/stackSpace.ts` is their client.
 *
 *   broadcast        { url, script?, stamped?, duration, outages?, stalls?,
 *                      jumps?, lead?, size?, fps?, sound? }
 *                    runs `node <script> --url rtmp://127.0.0.1:<live port>/<app>/<key> …`
 *                    in the checkout, the app and key taken from the camera's
 *                    `url`, and answers once it has printed `planned`
 *                    → { id, t0, events, exit }
 *   broadcast-status { id }   every event it has printed, and its exit code
 *                             once it has ended → { events, exit }
 *   broadcast-stop   { id }   stops it, and answers once it has ended
 *   ingest-files     { videoId }
 *                    the ingest's own live directory for the video
 *                    (`liveVideoDir`), every name in it, and its
 *                    `master.m3u8`, beside the stack's `live` settings
 *                    → { live, names, master }
 */

/** The broadcaster's two copies: `scoreboard` stamps, stalls and jumps; `outage` writes its clock in words too. */
export const BROADCASTERS = {
  scoreboard: 'scripts/e2e/scoreboardLog/fakeBroadcaster.mjs',
  outage: 'scripts/e2e/liveOutage/fakeBroadcaster.mjs'
} as const

/** What the `outage` copy has no flag for. */
const SCOREBOARD_ONLY = ['stamped', 'stalls', 'jumps'] as const

export interface BroadcastChild {
  stdout: Readable
  stderr: Readable
  on: (event: 'exit', listener: (code: number | null) => void) => unknown
  kill: (signal?: NodeJS.Signals) => boolean
}

export interface BroadcastDeps {
  /** The checkout the server runs from, where the broadcaster's script is. */
  checkout: string
  /** The stack's server config: its FFmpeg, media directory and live settings. */
  config: () => {
    ffmpegPath?: string
    mediaDir?: string
    live?: Record<string, unknown>
  }
  spawn: (
    file: string,
    args: string[],
    options: { cwd: string }
  ) => BroadcastChild
  readDir: (dir: string) => Promise<string[]>
  readText: (file: string) => Promise<string>
  makeId: () => string
  /** How long `broadcast` waits for `planned`. */
  plannedMs?: number
}

export interface BroadcastEvent {
  at: number
  event: string
  [key: string]: unknown
}

interface Running {
  child: BroadcastChild
  events: BroadcastEvent[]
  exit: number | null
  ended: Promise<void>
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
/** `rtmp://host[:port]/<app>/<key>`, as the API answers a camera. */
const CAMERA_URL =
  /^rtmps?:\/\/[^/\s]+\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._~-]{1,200})$/
const SIZE = /^\d{2,4}x\d{2,4}$/
const MAX_SECONDS = 3600
/** The events kept for a broadcast: a long one prints one line a stretch, far fewer. */
const MAX_EVENTS = 10_000

function bad(message: string): never {
  throw new RemuxError(400, message)
}

function seconds(value: unknown, name: string, min = 1): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > MAX_SECONDS
  ) {
    bad(`${name} is a number of seconds, ${min} to ${MAX_SECONDS}`)
  }
  return value
}

function stretches(value: unknown, name: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) bad(`${name} is a list of { at, seconds }`)
  return value.map((one: unknown) => {
    const { at, seconds: length } = (one ?? {}) as Record<string, unknown>
    return `${seconds(at, `${name}.at`)}:${seconds(length, `${name}.seconds`)}`
  })
}

/** The broadcaster's command line for `body`, publishing to the ingest on `livePort`. */
export function broadcasterArgs(
  body: Record<string, unknown>,
  livePort: number,
  ffmpeg: string
): string[] {
  const script = body.script ?? 'scoreboard'
  if (script !== 'scoreboard' && script !== 'outage') {
    bad('script is scoreboard or outage')
  }
  if (typeof body.url !== 'string') bad('url is the camera’s rtmp:// URL')
  const camera = CAMERA_URL.exec(body.url)
  if (camera == null) bad('url is the camera’s rtmp:// URL')
  if (script === 'outage') {
    for (const name of SCOREBOARD_ONLY) {
      if (body[name] != null && body[name] !== false) {
        bad(`${name} is the scoreboard broadcaster’s alone`)
      }
    }
  }
  const args = [
    BROADCASTERS[script],
    '--url',
    `rtmp://127.0.0.1:${livePort}/${camera[1]}/${camera[2]}`,
    '--duration',
    String(seconds(body.duration, 'duration')),
    '--ffmpeg',
    ffmpeg
  ]
  for (const at of stretches(body.outages, 'outages')) args.push('--outage', at)
  for (const at of stretches(body.stalls, 'stalls')) args.push('--stall', at)
  for (const at of stretches(body.jumps, 'jumps')) args.push('--jump', at)
  if (body.lead != null)
    args.push('--lead', String(seconds(body.lead, 'lead', 0)))
  if (body.size != null) {
    if (typeof body.size !== 'string' || !SIZE.test(body.size)) {
      bad('size is <width>x<height>')
    }
    args.push('--size', body.size)
  }
  if (body.fps != null) {
    if (
      typeof body.fps !== 'number' ||
      !Number.isInteger(body.fps) ||
      body.fps < 1 ||
      body.fps > 120
    ) {
      bad('fps is a whole number, 1 to 120')
    }
    args.push('--fps', String(body.fps))
  }
  for (const flag of ['stamped', 'sound'] as const) {
    if (body[flag] != null && typeof body[flag] !== 'boolean') {
      bad(`${flag} is true or false`)
    }
    if (body[flag] === true) args.push(`--${flag}`)
  }
  return args
}

/** The broadcast actions over `deps`, by action name. */
export function broadcastActions(
  deps: BroadcastDeps
): Record<string, (body: Record<string, unknown>) => Promise<unknown>> {
  const running = new Map<string, Running>()
  const livePort = (): number => {
    const port = deps.config().live?.port
    if (typeof port !== 'number') {
      throw new RemuxError(501, 'the stack’s server config has no live port')
    }
    return port
  }
  const find = (body: Record<string, unknown>): Running => {
    const id = body.id
    if (typeof id !== 'string' || !ID.test(id)) bad('id is a broadcast’s id')
    const found = running.get(id)
    if (found == null) throw new RemuxError(404, `no broadcast ${id}`)
    return found
  }
  const status = (
    one: Running
  ): { events: BroadcastEvent[]; exit: number | null } => ({
    events: [...one.events],
    exit: one.exit
  })

  return {
    broadcast: async body => {
      const args = broadcasterArgs(
        body,
        livePort(),
        deps.config().ffmpegPath ?? 'ffmpeg'
      )
      const id = deps.makeId()
      const child = deps.spawn(process.execPath, args, { cwd: deps.checkout })
      const one: Running = {
        child,
        events: [],
        exit: null,
        ended: new Promise(resolve => {
          child.on('exit', code => {
            one.exit = code ?? 1
            resolve()
          })
        })
      }
      running.set(id, one)
      let planned: (event: BroadcastEvent) => void = () => undefined
      const plannedEvent = new Promise<BroadcastEvent>(resolve => {
        planned = resolve
      })
      const stderr: string[] = []
      createInterface({ input: child.stderr }).on('line', line => {
        stderr.push(line)
        if (stderr.length > 20) stderr.shift()
      })
      createInterface({ input: child.stdout }).on('line', line => {
        let event: BroadcastEvent
        try {
          event = JSON.parse(line) as BroadcastEvent
        } catch {
          event = { at: Date.now(), event: 'output', line }
        }
        if (one.events.length < MAX_EVENTS) one.events.push(event)
        if (event.event === 'planned') planned(event)
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => {
          resolve('timeout')
        }, deps.plannedMs ?? 60_000)
      })
      const first = await Promise.race([
        plannedEvent,
        one.ended.then(() => 'ended' as const),
        timeout
      ])
      clearTimeout(timer)
      if (first === 'ended' || first === 'timeout') {
        child.kill('SIGTERM')
        running.delete(id)
        throw new RemuxError(
          502,
          `the broadcaster ${first === 'ended' ? `exited ${one.exit}` : 'planned nothing in time'}: ${stderr.join(' | ').slice(-500)}`
        )
      }
      const t0 = Number(first.t0)
      return { id, t0, ...status(one) }
    },

    'broadcast-status': async body => status(find(body)),

    'broadcast-stop': async body => {
      const one = find(body)
      if (one.exit == null) {
        one.child.kill('SIGTERM')
        await one.ended
      }
      return status(one)
    },

    'ingest-files': async body => {
      const videoId = body.videoId
      if (typeof videoId !== 'string' || !ID.test(videoId)) {
        bad('videoId is a video’s id')
      }
      const config = deps.config()
      if (config.mediaDir == null) {
        throw new RemuxError(501, 'the stack’s server config has no mediaDir')
      }
      const dir = liveVideoDir(config.mediaDir, videoId)
      const names = (await deps.readDir(dir).catch(() => [] as string[])).sort()
      const master = await deps
        .readText(join(dir, 'master.m3u8'))
        .catch(() => '')
      return { live: config.live ?? {}, names, master }
    }
  }
}

/** The actions a stack's fault server runs, on its own checkout and server config. */
export function stackBroadcasts(
  checkout: string,
  config: BroadcastDeps['config']
): ReturnType<typeof broadcastActions> {
  return broadcastActions({
    checkout,
    config,
    spawn: (file, args, options) =>
      spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
    readDir: async dir => await readdir(dir),
    readText: async file => await readFile(file, 'utf8'),
    makeId: () =>
      `bc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  })
}
