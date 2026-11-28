import { BlockedError } from '../../core/result'
import type { HarnessContext, StackControl } from '../../core/spec'

/**
 * The media work a recording scenario needs done on the stack itself, where
 * the API, its database and its Space are: each is one call to the stack's
 * `remux` control route, which runs it there and answers what it did. A
 * test never reaches the stack's droplet, database or Space keys itself.
 *
 * The route takes `{ action, ... }`:
 *
 *   programme   { seconds, path }      encodes a test programme (HEVC with
 *                                      sound, keyed every 2 s) and serves it
 *                                      on the pages stand-in at `path`
 *                                      → { path, bytes }
 *   single-file { videoId, gameId, title, startAt, seconds }
 *                                      a programme remuxed to one video.mp4
 *                                      under videos/<videoId>/, and its row,
 *                                      as every upload before segments was
 *                                      → { videoId }
 *   segment     { args }               `segmentSpaceVideos` with `args`
 *                                      → { output }
 *   objects     { prefix }             the Space's objects under `prefix`
 *                                      → { objects: [{ key, size }] }
 *   play        { gameId, battingTeamId, videoId, secondsIn, atBatIndex }
 *                                      a play `secondsIn` into the video's
 *                                      own clock, so the game lists it as a
 *                                      highlight → { eventId }
 *   machine     {}                     the droplet's size → { vcpus, memGiB }
 *   take        { seconds, path }      a short H.264 take with no B-frames
 *                                      and no sound, on the pages stand-in,
 *                                      and what ffprobe reads of it
 *                                      → { path, bytes, streams, firstDts }
 *   broadcast   { url, script?, stamped?, duration, outages?, stalls?,
 *                 jumps?, lead?, size?, fps?, sound? }
 *                                      the fake broadcaster, on the stack,
 *                                      publishing into its own ingest at the
 *                                      camera URL's app and key, answered
 *                                      once it has planned its start
 *                                      → { id, t0, events }
 *   broadcast-status { id }            what it has printed since, whether
 *                                      it waits for an encode slot, and its
 *                                      exit code once it has ended
 *                                      → { events, stderr, queued, exit }
 *   broadcast-stop   { id }            stops it → { events, exit }
 *   ingest-files { videoId }           the ingest's own disk for a live
 *                                      video, and its live settings
 *                                      → { live, names, master }
 */
export interface StackMedia {
  programme: (options: {
    seconds: number
    path: string
  }) => Promise<{ path: string; bytes: number }>
  singleFile: (options: {
    videoId: string
    gameId: string
    title: string
    startAt: string
    seconds: number
  }) => Promise<{ videoId: string }>
  segment: (args: string[]) => Promise<string>
  objects: (prefix: string) => Promise<Array<{ key: string; size: number }>>
  play: (options: {
    gameId: string
    battingTeamId: string
    videoId: string
    secondsIn: number
    atBatIndex: number
  }) => Promise<string>
  machine: () => Promise<{ vcpus: number; memGiB: number }>
  /** A take as Director's upload client sends one, made on the stack and served on its pages stand-in. */
  take: (options: { seconds: number; path: string }) => Promise<{
    path: string
    bytes: number
    /** `<type>/<codec>` per stream, as ffprobe names them. */
    streams: string[]
    /** The first packet's decode time, null when ffprobe read none. */
    firstDts: number | null
  }>
  /**
   * The fake broadcaster (`scripts/e2e/scoreboardLog/fakeBroadcaster.mjs`, or
   * with `script: 'outage'` `scripts/e2e/liveOutage/fakeBroadcaster.mjs`)
   * run on the stack, a camera publishing into the stack's own ingest. It
   * answers once the broadcaster has planned its start, T0.
   */
  broadcast: (options: BroadcastOptions) => Promise<Broadcast>
  /** What a broadcast has printed so far, and its exit code once it is over. */
  broadcastStatus: (id: string) => Promise<BroadcastStatus>
  /** Stops a broadcast that is still publishing. */
  broadcastStop: (id: string) => Promise<BroadcastStatus>
  /** What the ingest keeps on its own disk for a live video. */
  ingestFiles: (videoId: string) => Promise<IngestFiles>
}

/** A stretch of a broadcast: `at` seconds in, for `seconds`. */
export interface BroadcastStretch {
  at: number
  seconds: number
}

/** The fake broadcaster's options, as its command line names them. */
export interface BroadcastOptions {
  /** The camera's `rtmp://` URL as the API answered it; its app and key are kept. */
  url: string
  /** `scoreboard` (the default) or `outage`, the broadcaster's two copies. */
  script?: 'scoreboard' | 'outage'
  stamped?: boolean
  duration: number
  outages?: BroadcastStretch[]
  stalls?: BroadcastStretch[]
  jumps?: BroadcastStretch[]
  lead?: number
  /** `<width>x<height>`. */
  size?: string
  fps?: number
  sound?: boolean
}

/** One line the broadcaster printed: `{ at, event, ... }`. */
export interface BroadcastEvent {
  at: number
  event: string
  [key: string]: unknown
}

export interface BroadcastStatus {
  events: BroadcastEvent[]
  /** The broadcaster's standard error, when the stack sends it. */
  stderr?: string[]
  /** Null while it runs. */
  exit: number | null
  /** Still waiting for one of the stack's encode slots. */
  queued?: boolean
}

export interface Broadcast extends BroadcastStatus {
  id: string
  /** The wall time, in ms, its picture's clock starts at. */
  t0: number
  /**
   * The lead it was given, in seconds: the one asked for, or more when the
   * stack's encode queue plans its T0 later.
   */
  lead?: number
}

export interface IngestFiles {
  /** The stack's `live` server settings as configured; unset ones take the server's defaults. */
  live: Record<string, unknown>
  /** The file names in the video's live directory, `[]` when it has none. */
  names: string[]
  /** Its `master.m3u8`, `''` when it has none. */
  master: string
}

/** Polls a broadcast until `done` holds of its status, or throws naming `what`. */
export async function untilBroadcast(
  media: Pick<StackMedia, 'broadcastStatus'>,
  id: string,
  what: string,
  done: (status: BroadcastStatus) => boolean,
  options: { timeoutMs?: number; everyMs?: number } = {}
): Promise<BroadcastStatus> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000)
  for (;;) {
    const status = await media.broadcastStatus(id)
    if (done(status)) return status
    if (status.exit != null) {
      throw new Error(
        `the broadcast ended (exit ${status.exit}) before ${what}: ${JSON.stringify(status.events.slice(-3))}${status.stderr == null || status.stderr.length === 0 ? '' : `; it said: ${status.stderr.slice(0, 10).join(' | ')}`}`
      )
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, options.everyMs ?? 1000))
  }
}

/** The stack's control routes, or blocked: these scenarios need them. */
export function stackControl(ctx: HarnessContext): StackControl {
  const control = ctx.stack.control
  if (control == null) {
    throw new BlockedError('this stack has no control routes for its media')
  }
  return control
}

/** The stack's API, where the apps send their uploads. */
export function stackApi(ctx: HarnessContext): string {
  return `${ctx.stack.origin.replace(/\/+$/, '')}/api/v1`
}

/** The media actions above, over the stack's `remux` route. */
export function stackMedia(control: Pick<StackControl, 'remux'>): StackMedia {
  const call = async (action: string, body: object): Promise<any> =>
    await control.remux({ action, ...body })
  return {
    programme: async options => await call('programme', options),
    singleFile: async options => await call('single-file', options),
    segment: async args =>
      ((await call('segment', { args })) as { output: string }).output,
    objects: async prefix =>
      (
        (await call('objects', { prefix })) as {
          objects: Array<{ key: string; size: number }>
        }
      ).objects,
    play: async options =>
      ((await call('play', options)) as { eventId: string }).eventId,
    machine: async () => await call('machine', {}),
    take: async options => await call('take', options),
    broadcast: async options => await call('broadcast', options),
    broadcastStatus: async id => await call('broadcast-status', { id }),
    broadcastStop: async id => await call('broadcast-stop', { id }),
    ingestFiles: async videoId => await call('ingest-files', { videoId })
  }
}
