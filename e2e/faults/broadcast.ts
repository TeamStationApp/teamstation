import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { cpus } from 'node:os'
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
 *                    runs `node <script> --url rtmp://127.0.0.1:<live port>/<app>/<key> --t0 …`
 *                    in the checkout, the app and key taken from the camera's
 *                    `url`, its T0 planned by the encode queue (below)
 *                    → { id, t0, lead, queued, events, stderr, exit }
 *   broadcast-status { id }   every event it has printed, all its
 *                             standard error, whether it still waits for an
 *                             encode slot, and its exit code once it has
 *                             ended → { events, stderr, queued, exit }
 *   broadcast-stop   { id }   stops it (or takes it off the queue), and
 *                             answers once it has ended
 *   ingest-files     { videoId }
 *                    the ingest's own live directory for the video
 *                    (`liveVideoDir`), every name in it, and its
 *                    `master.m3u8`, beside the stack's `live` settings
 *                    → { live, names, master }
 *
 * The encode queue. The broadcaster encodes its whole picture before T0, on
 * the same processors as the stack's API and ingest, so at most `encodeSlots`
 * broadcasters encode at once. A broadcast is given the slot that frees
 * first, by the queue's own estimates (`encodeSeconds`), and a T0 once its
 * encode is due to end, never sooner than the lead it asked for; it answers
 * at once with that T0. Its broadcaster starts when a slot really frees (the
 * one before it printed `encoded`, or ended), which is no later than planned.
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
  /** This machine's processors, which the encode slots and estimates scale with. */
  vcpus: () => number
  /** The wall clock, in ms. */
  now?: () => number
  /** Where the broadcaster's standard error is written as it comes. */
  log: (line: string) => void
  /** How long `broadcast` waits for `planned`. */
  plannedMs?: number
}

export interface BroadcastEvent {
  at: number
  event: string
  [key: string]: unknown
}

interface Running {
  child?: BroadcastChild
  /** Starts its broadcaster: run once a slot is free. */
  start: () => void
  events: BroadcastEvent[]
  exit: number | null
  /** Its standard error, which says why a broadcast failed. */
  stderr: string[]
  /** Holding an encode slot: started, and not yet `encoded` or ended. */
  encoding: boolean
  ended: Promise<void>
  end: (code: number) => void
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

function seconds(
  value: unknown,
  name: string,
  min = 1,
  max = MAX_SECONDS
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    bad(`${name} is a number of seconds, ${min} to ${max}`)
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

/** How many broadcasters encode at once on a machine of `vcpus`: two on the pool's 8. */
export function encodeSlots(vcpus: number): number {
  return Math.max(1, Math.round(vcpus / 4))
}

/**
 * How long, in seconds, a broadcast of `duration` seconds takes to encode
 * while every slot of a `vcpus` machine encodes. On the pool's 8-vCPU
 * droplet one 60 s picture took 25 s to encode and four at once 66 s each,
 * close to 0.2 + 0.225 s a second of picture for each encode running; then
 * half as much again to spare, and twenty seconds to start.
 */
export function encodeSeconds(duration: number, vcpus: number): number {
  const slots = encodeSlots(vcpus)
  const perSecond = (0.2 + 0.225 * slots) * (8 / Math.max(1, vcpus))
  return Math.ceil(20 + duration * perSecond * 1.5)
}

/**
 * Plans a broadcast on the queue: the slot that frees first (`slotFree`, each
 * slot's planned end in wall ms, moved on to this encode's), and the T0, in
 * wall ms on a whole second, once its encode is due to end and no sooner
 * than `askedLead` seconds from `now`.
 */
export function planBroadcast(
  slotFree: number[],
  now: number,
  duration: number,
  askedLead: number,
  vcpus: number
): { t0: number; lead: number } {
  let slot = 0
  for (let i = 1; i < slotFree.length; i++)
    if (slotFree[i] < slotFree[slot]) slot = i
  const encoded =
    Math.max(now, slotFree[slot]) + encodeSeconds(duration, vcpus) * 1000
  slotFree[slot] = encoded
  const t0 = Math.ceil(Math.max(encoded, now + askedLead * 1000) / 1000) * 1000
  return { t0, lead: (t0 - now) / 1000 }
}

/** The broadcaster's own default lead: ten seconds and a quarter of the length. */
export function defaultLead(duration: number): number {
  return 10 + duration / 4
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
  if (body.t0 != null) {
    if (typeof body.t0 !== 'number' || !Number.isInteger(body.t0)) {
      bad('t0 is a wall time in whole ms')
    }
    args.push('--t0', String(body.t0))
  } else if (body.lead != null) {
    args.push('--lead', String(seconds(body.lead, 'lead', 0)))
  }
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
  const now = deps.now ?? Date.now
  const vcpus = deps.vcpus()
  const slots = encodeSlots(vcpus)
  const slotFree: number[] = Array.from({ length: slots }, () => 0)
  const queue: Running[] = []
  /** Starts queued broadcasters while a slot is free. */
  const next = (): void => {
    while (
      queue.length > 0 &&
      [...running.values()].filter(one => one.encoding).length < slots
    ) {
      queue.shift()!.start()
    }
  }
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
  ): {
    events: BroadcastEvent[]
    exit: number | null
    stderr: string[]
    queued: boolean
  } => ({
    events: [...one.events],
    exit: one.exit,
    stderr: [...one.stderr],
    queued: one.child == null && one.exit == null
  })

  return {
    broadcast: async body => {
      const duration = seconds(body.duration, 'duration')
      const asked =
        body.lead == null
          ? defaultLead(duration)
          : seconds(body.lead, 'lead', 0)
      // Checked before the plan, so a body it refuses takes no slot.
      const port = livePort()
      const ffmpeg = deps.config().ffmpegPath ?? 'ffmpeg'
      broadcasterArgs({ ...body, lead: undefined, t0: 0 }, port, ffmpeg)
      const { t0, lead } = planBroadcast(
        slotFree,
        now(),
        duration,
        asked,
        vcpus
      )
      const args = broadcasterArgs(
        { ...body, lead: undefined, t0 },
        port,
        ffmpeg
      )
      const id = deps.makeId()
      let planned: (event: BroadcastEvent) => void = () => undefined
      const plannedEvent = new Promise<BroadcastEvent>(resolve => {
        planned = resolve
      })
      let resolveEnded: () => void = () => undefined
      const one: Running = {
        events: [],
        exit: null,
        stderr: [],
        encoding: false,
        ended: new Promise(resolve => {
          resolveEnded = resolve
        }),
        end: code => {
          if (one.exit != null) return
          one.exit = code
          one.encoding = false
          resolveEnded()
          next()
        },
        start: () => {
          const child = deps.spawn(process.execPath, args, {
            cwd: deps.checkout
          })
          one.child = child
          one.encoding = true
          child.on('exit', code => {
            one.end(code ?? 1)
          })
          createInterface({ input: child.stderr }).on('line', line => {
            // All of it, in the status and in the fault server's own log,
            // which a stack's down keeps: the first line says why it failed.
            if (one.stderr.length < MAX_EVENTS) one.stderr.push(line)
            deps.log(`broadcast ${id}: ${line}`)
          })
          createInterface({ input: child.stdout }).on('line', line => {
            let event: BroadcastEvent
            try {
              event = JSON.parse(line) as BroadcastEvent
            } catch {
              event = { at: now(), event: 'output', line }
            }
            if (one.events.length < MAX_EVENTS) one.events.push(event)
            if (event.event === 'planned') planned(event)
            if (event.event === 'encoded' && one.encoding) {
              one.encoding = false
              next()
            }
          })
        }
      }
      running.set(id, one)
      queue.push(one)
      next()
      if (one.child == null) return { id, t0, lead, ...status(one) }
      // Started at once: answer once it has planned, or say why it did not.
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
        one.child.kill('SIGTERM')
        running.delete(id)
        throw new RemuxError(
          502,
          `the broadcaster ${first === 'ended' ? `exited ${one.exit}` : 'planned nothing in time'}: ${one.stderr.join(' | ').slice(0, 2000)}`
        )
      }
      return { id, t0: Number(first.t0), lead, ...status(one) }
    },

    'broadcast-status': async body => status(find(body)),

    'broadcast-stop': async body => {
      const one = find(body)
      if (one.exit == null) {
        if (one.child == null) {
          queue.splice(queue.indexOf(one), 1)
          one.end(143)
        } else {
          one.child.kill('SIGTERM')
        }
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
    vcpus: () => cpus().length,
    log: line => {
      console.error(line)
    },
    makeId: () =>
      `bc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  })
}
