import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import { readdirSync, readFileSync, writeFileSync } from 'fs'

import { KEEP_STREAM_TIMES } from '../media/ffmpeg'
import { segmentPictureSec } from '../media/trackStarts'

/**
 * The RTMP ingest, and the split.
 *
 * One stream arrives — from TS Director, or from anything else that was given
 * the URL — and goes into TeamStation's own HLS on this machine, and on to any
 * further RTMP destination it is given. Every leg is `-c copy`, so nothing is
 * ever re-encoded and whatever the Director sent is what everybody receives.
 *
 * The process handling here is the splitter TeamStation 1.0 has been running
 * for a year (`src/server/rtmp/splitter.ts` at 25f9496e), brought across deliberately
 * unchanged in the parts that look strange. Every one of them is a production
 * failure that was paid for once: ffmpeg children Node reports as exited while
 * the OS still has them, publishers whose TCP peer died without a FIN so the
 * server never learned the stream was gone, SIGTERM ignored during a blocking
 * write. Tidying those away re-buys the bugs.
 *
 * What is new here is authentication and the HLS leg. The ingest never asks
 * the database anything: the controller hands it the keys that are allowed to
 * publish right now, and it tells the controller what happened. A publish with
 * a key it was not given is closed on arrival.
 */

/** A session as node-media-server hands it to us. */
interface NmsSession {
  id: string
  streamApp?: string
  streamName?: string
  streamPath?: string
  inBytes?: number
  isPublisher?: boolean
  /**
   * What the publisher said it is sending, from the stream's metadata. Not
   * known when the publish starts — it arrives a moment later — so it is read
   * on the sampler's first tick rather than at `postPublish`.
   *
   * A number is a classic FLV codec id (7 is H.264, 12 is HEVC); enhanced RTMP
   * sends a four-character code instead.
   */
  videoCodec?: number | string
  // RtmpSession.close() ends the underlying TCP socket, which (when the socket
  // is healthy) cascades through onClose -> broadcast.donePublish -> our
  // donePublish handler, releasing the "already has a publisher" lock.
  close?: () => void
  // The raw net.Socket, for the case where close() is a no-op because the
  // socket is already half-closed and only destroy() makes Node fire close.
  socket?: { destroy?: () => void }
  // The BroadcastServer node-media-server attaches to a publishing session.
  // Calling donePublish on it releases the publisher lock even when the
  // socket-close path never fires. Idempotent: it checks the session first.
  //
  // `subscribers` are the sessions reading this stream, which here are our own
  // ffmpeg children and nothing else — viewers watch the HLS, not the RTMP.
  broadcast?: {
    donePublish?: (session: NmsSession) => void
    subscribers?: Map<string, { close?: () => void }>
  }
}
interface NmsInstance {
  on: (event: string, listener: (session: NmsSession) => void) => void
  run: () => void
  stop?: () => void
}
type NmsCtor = new (config: Record<string, unknown>) => NmsInstance

export type OutputState =
  'idle' | 'connecting' | 'connected' | 'error' | 'stopped'

export interface OutputStatus {
  /** `hls` writes this machine's own copy; `rtmp` pushes somebody else's. */
  kind: 'hls' | 'rtmp'
  /** The destination, with any stream key removed. Safe to show and to log. */
  label: string
  state: OutputState
  lastError?: string
  bytesWritten: number
  bytesPerSecond: number
  /**
   * How much video this output has written, in seconds.
   *
   * The measure that means something for the HLS leg, which writes a file per
   * segment and so has no single size — ffmpeg reports `total_size=N/A` for it.
   * "Three minutes and forty-one seconds recorded" is what an operator wanted
   * to know from the byte counter anyway.
   */
  recordedSec?: number
  restartCount: number
}

export interface IngressStatus {
  publishing: boolean
  receivingPackets: boolean
  bytesReceived: number
  bytesPerSecond: number
}

export interface LiveStatus {
  liveStreamId: string
  ingress: IngressStatus
  outputs: OutputStatus[]
}

/** What the ingest is told to do with one key. */
export interface LiveSpec {
  liveStreamId: string
  /** Where the HLS goes. The directory is created before the stream starts. */
  hlsDir: string
  /** Onward RTMP destinations, keys and all. Never logged, never shown. */
  destinations: string[]
}

export type LiveEvent =
  | { type: 'publishStarted'; key: string; liveStreamId: string }
  | { type: 'publishEnded'; key: string; liveStreamId: string; reason: string }
  | { type: 'rejected'; key: string; reason: string }
  | { type: 'status'; key: string; status: LiveStatus }

export interface IngestConfig {
  ffmpegPath: string
  bindHost: string
  port: number
  app: string
  segmentSeconds: number
  onEvent: (event: LiveEvent) => void
  log: (message: string) => void
  /**
   * Looks a key up that the ingest has not been told about.
   *
   * The keys it holds are refreshed on a timer, so a stream created seconds
   * ago is not in that set yet — and somebody who has just been handed a URL
   * is exactly the person about to use it. Rather than refuse them and make
   * them try again, the ingest asks once. `undefined` means the key is not
   * one of ours; a **string** means it is, and this publish is still refused,
   * for the reason the string gives.
   */
  resolve?: (key: string) => Promise<LiveSpec | string | undefined>
}

interface OutputRuntime {
  kind: 'hls' | 'rtmp'
  /** The full ffmpeg target: an RTMP URL with its key, or a playlist path. */
  target: string
  label: string
  state: OutputState
  lastError?: string
  bytesWritten: number
  bytesPerSecond: number
  bytesAtLastTick: number
  recordedSec?: number
  restartCount: number
  /** When the current child started, for judging whether it settled. */
  startedAt?: number
  /** The child this runtime currently considers its own. */
  child?: ChildProcess
  /**
   * Every child spawned for this output that is not OS-confirmed dead.
   *
   * Node cannot be fully trusted to fire `exit` only when the process is
   * really gone: a SIGCHLD reap race has been observed to report an exit for
   * an ffmpeg that was still running and still pushing to a destination. Every
   * child stays here until the sampler sees its PID disappear, so a stop can
   * reliably signal the survivors.
   */
  spawned: Set<ChildProcess>
  restartTimer?: NodeJS.Timeout
  /** ffmpeg can ignore SIGTERM during a blocking write, so a SIGKILL follows. */
  killEscalationTimer?: NodeJS.Timeout
  /**
   * Retired. A restart timer or an in-flight exit handler from an earlier
   * generation still holds this object, and must not spawn anything.
   */
  released: boolean
  /**
   * Where an HLS writer that appends to an existing playlist carries on from:
   * the playlist's own first sequence number, and how many seconds of video
   * it already holds.
   */
  continuation?: Continuation
  hlsRestarted?: boolean
  /**
   * Finishing of its own accord rather than being killed.
   *
   * When the publisher goes, the HLS writer is left alone for a moment: it
   * sees the end of the stream and flushes the segment it was part way
   * through. Killing it there costs the last few seconds of every recording —
   * the whole point being that the video runs as long as the game did.
   *
   * It does **not** close the playlist (`omit_endlist`). A publisher that has
   * gone is usually back within seconds, and every player that reads an
   * `EXT-X-ENDLIST` takes the game to be over and stops asking for more, for
   * good. The controller closes the playlist when the stream really has
   * finished: its publisher stayed away past `RECONNECT_GRACE_MS`, or
   * somebody ended it.
   */
  draining?: boolean
  drainTimer?: NodeJS.Timeout
  /** The publisher came back while the last writer was still finishing. */
  pendingRespawn?: boolean
}

interface IngressRuntime {
  publishing: boolean
  /**
   * The path the publisher actually used, which is not always the canonical
   * one: software that asks for a server and a key in two boxes sends the
   * whole address as the app, with no stream name at all. The readers have to
   * subscribe to the same path or they sit waiting for a stream that is being
   * published under a different name.
   */
  path?: string
  receivingPackets: boolean
  bytesReceived: number
  bytesPerSecond: number
  bytesAtLastTick: number
  session?: NmsSession
  /** Whether the stream's codec has been looked at yet. Once per publish. */
  codecChecked?: boolean
  /**
   * Consecutive one-second ticks of "publishing, but no bytes". At
   * STALE_INGRESS_TICKS the publisher is taken to be a corpse whose socket
   * never closed, and it is cleared by force — otherwise every reconnect is
   * refused with "already has a publisher" until somebody restarts the server.
   */
  zeroByteTicks: number
}

interface LiveEntry {
  key: string
  liveStreamId: string
  hlsDir: string
  destinations: string[]
  ingress: IngressRuntime
  outputs: OutputRuntime[]
}

/**
 * What the live playlist is called.
 *
 * `master.m3u8` because that is the name every local video is looked up by
 * (`locateVideo`), and a live stream must be playable through exactly the same
 * path as a finished one — the row's storage says `local` in both cases, and
 * the only difference is whether the playlist has ended yet.
 */
export const LIVE_PLAYLIST_NAME = 'master.m3u8'

const SAMPLE_INTERVAL_MS = 1000
const BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000]
/** How long a writer must have run for its next failure to count as the first. */
const SETTLED_MS = 60_000

/**
 * How long a writer waits before it is started again, and what that leaves
 * the count at.
 *
 * Failures close together escalate — an ffmpeg that cannot start at all
 * should not be spawned a thousand times a minute. Failures an hour apart do
 * not: a writer that ran for a minute before it died was working, and a
 * network blip in the first over must not cost ten seconds of every
 * reconnection for the rest of a three-hour game.
 */
export function restartDelay(
  restartCount: number,
  ranForMs: number
): { delayMs: number; nextCount: number } {
  const count = ranForMs > SETTLED_MS ? 0 : restartCount
  const delayMs = BACKOFF_STEPS_MS[Math.min(count, BACKOFF_STEPS_MS.length - 1)]
  return { delayMs, nextCount: count + 1 }
}
/**
 * How long a child gets between SIGTERM and SIGKILL. Short on purpose: until
 * it is gone it may still hold the destination's stream key, and most services
 * allow one publisher per key.
 */
const SIGKILL_GRACE_MS = 3000
/**
 * How long the HLS writer gets to finish by itself after the stream ends.
 * Long enough to flush a segment and close the playlist, short enough that a
 * wedged one does not hold a reconnect up.
 */
const HLS_DRAIN_MS = 10_000
const STALE_INGRESS_TICKS = 30
/**
 * Silent ticks after which a publisher gives way to a new publish on its key.
 *
 * An encoder whose network dropped redials the moment it is back, while its
 * old connection, dead without a FIN, still holds the key. Waiting out
 * STALE_INGRESS_TICKS for that corpse kept a phone off the air for half a
 * minute after a twenty-second cut. A publisher that has sent nothing for
 * this long is not the stream any more, so the newcomer replaces it at once;
 * one still sending keeps the key, and the newcomer is refused as before.
 */
const TAKEOVER_SILENT_TICKS = 2

const entries = new Map<string, LiveEntry>()
let config: IngestConfig | undefined
let nmsInstance: NmsInstance | undefined
let pollTimer: NodeJS.Timeout | undefined

/**
 * A publish path segment we are willing to look up.
 *
 * Nothing but our own key alphabet gets through, because the value ends up in
 * an ffmpeg argument and in a file path.
 */
export function isPublishableKey(value: string | undefined): value is string {
  return value != null && /^[A-Za-z0-9_-]{8,128}$/.test(value)
}

/** An RTMP URL with its key replaced, for logs and for anything on a screen. */
export function hideKey(url: string): string {
  const at = url.lastIndexOf('/')
  if (at < 0) return url
  return `${url.slice(0, at + 1)}…`
}

function requireConfig(): IngestConfig {
  if (config == null) throw new Error('The live ingest is not configured')
  return config
}

export function configureIngest(next: IngestConfig): void {
  config = next
}

function makeIngress(): IngressRuntime {
  return {
    publishing: false,
    receivingPackets: false,
    bytesReceived: 0,
    bytesPerSecond: 0,
    bytesAtLastTick: 0,
    zeroByteTicks: 0
  }
}

function makeOutput(
  kind: 'hls' | 'rtmp',
  target: string,
  label: string
): OutputRuntime {
  return {
    kind,
    target,
    label,
    state: 'idle',
    bytesWritten: 0,
    bytesPerSecond: 0,
    bytesAtLastTick: 0,
    restartCount: 0,
    spawned: new Set<ChildProcess>(),
    released: false
  }
}

function outputsFor(spec: LiveSpec): OutputRuntime[] {
  const outputs = [
    makeOutput('hls', `${spec.hlsDir}/${LIVE_PLAYLIST_NAME}`, 'TeamStation')
  ]
  for (const url of spec.destinations) {
    outputs.push(makeOutput('rtmp', url, hideKey(url)))
  }
  return outputs
}

function isPidAlive(pid: number | undefined): boolean {
  if (pid == null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Signals a PID directly rather than through the ChildProcess wrapper, which
 * sets an internal `killed` flag after the first call and may then refuse to
 * signal a process that is demonstrably still alive.
 */
function killByPid(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid == null || pid <= 0) return
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone, which is the outcome we wanted.
  }
}

function toStatus(entry: LiveEntry): LiveStatus {
  return {
    liveStreamId: entry.liveStreamId,
    ingress: {
      publishing: entry.ingress.publishing,
      receivingPackets: entry.ingress.receivingPackets,
      bytesReceived: entry.ingress.bytesReceived,
      bytesPerSecond: entry.ingress.bytesPerSecond
    },
    outputs: entry.outputs.map(output => ({
      kind: output.kind,
      label: output.label,
      state: output.state,
      lastError: output.lastError,
      bytesWritten: output.bytesWritten,
      bytesPerSecond: output.bytesPerSecond,
      recordedSec: output.recordedSec,
      restartCount: output.restartCount
    }))
  }
}

function report(entry: LiveEntry): void {
  requireConfig().onEvent({
    type: 'status',
    key: entry.key,
    status: toStatus(entry)
  })
}

/**
 * Public surface ------------------------------------------------------------
 */

/**
 * Allows a key to publish, and says where its stream goes.
 *
 * Called again for the same key whenever the game's destinations change —
 * an onward destination switched on or off mid-game is exactly this — and then
 * the outputs are **reconciled** rather than replaced: an output whose target
 * is still wanted is left running, one that is no longer wanted is retired,
 * and one that is new is started. Replacing them all cost seconds of the
 * recording and a discontinuity in its playlist every time somebody touched
 * an onward switch, which is not what that switch is about.
 *
 * Retiring is still the only way an unwanted output ends: `released` is what
 * stops a restart timer from an old generation coming back later and pushing
 * to a destination that was turned off.
 */
export function setLive(key: string, spec: LiveSpec): void {
  if (!isPublishableKey(key)) throw new Error('Not a publishable key')
  let entry = entries.get(key)
  if (entry == null) {
    entry = {
      key,
      liveStreamId: spec.liveStreamId,
      hlsDir: spec.hlsDir,
      destinations: [...spec.destinations],
      ingress: makeIngress(),
      outputs: []
    }
    entries.set(key, entry)
  }
  const unchanged =
    entry.outputs.length > 0 &&
    entry.hlsDir === spec.hlsDir &&
    entry.destinations.length === spec.destinations.length &&
    entry.destinations.every((url, at) => url === spec.destinations[at])
  if (unchanged) return

  entry.liveStreamId = spec.liveStreamId
  entry.hlsDir = spec.hlsDir
  entry.destinations = [...spec.destinations]

  const wanted = outputsFor(spec)
  const keep: OutputRuntime[] = []
  for (const output of entry.outputs) {
    const still = wanted.some(
      next => next.kind === output.kind && next.target === output.target
    )
    if (still) {
      keep.push(output)
      continue
    }
    output.released = true
    stopOutput(output)
    requireConfig().log(
      `[live:${entry.liveStreamId}] ${output.label} retired (reconfigured)`
    )
  }

  const fresh = wanted.filter(
    next =>
      !keep.some(held => held.kind === next.kind && held.target === next.target)
  )
  entry.outputs = [...keep, ...fresh]
  if (entry.ingress.publishing) {
    for (const output of fresh) spawnOutput(entry, output)
  }
  report(entry)
}

/**
 * Takes a key away: nothing more may publish with it, and anything publishing
 * now is disconnected. The window closing, a rotation and a revocation all
 * land here.
 */
export function clearLive(key: string, reason: string): void {
  const entry = entries.get(key)
  if (entry == null) return
  const wasPublishing = entry.ingress.publishing
  if (entry.ingress.publishing || entry.ingress.session != null) {
    forceCloseIngress(entry, reason)
  }
  releaseOutputs(entry, reason)
  entries.delete(key)
  report(entry)
  // Somebody was publishing and now is not, and nothing else will say so: the
  // session was closed from this side, so the server's own done-publish hook
  // has nothing left to match it against. Without this the row goes on saying
  // `publishing` about a stream that was cut off — which is what a rotation
  // and a revocation both are.
  if (wasPublishing) {
    requireConfig().onEvent({
      type: 'publishEnded',
      key,
      liveStreamId: entry.liveStreamId,
      reason
    })
  }
}

/**
 * `clearLive`, and then waits for the key's ffmpeg children to be gone.
 *
 * A writer told to stop flushes the segment it was part way through and
 * writes its playlist one last time on the way out, so whatever closes the
 * playlist after this — the end of a game — must not run until it has: the
 * writer's last word would land on top of the close.
 *
 * It waits on the children's own `exit` events, bounded by the SIGKILL that
 * follows a writer ignoring the SIGTERM.
 */
export async function clearLiveSettled(
  key: string,
  reason: string
): Promise<void> {
  const entry = entries.get(key)
  const children =
    entry == null ? [] : entry.outputs.flatMap(output => [...output.spawned])
  clearLive(key, reason)
  const running = (child: ChildProcess): boolean =>
    child.exitCode == null && child.signalCode == null && isPidAlive(child.pid)
  const exited = children.filter(running).map(async child => {
    await new Promise<void>(resolve => {
      child.once('exit', () => {
        resolve()
      })
    })
  })
  if (exited.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(exited),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, SIGKILL_GRACE_MS + 1000)
    })
  ])
  clearTimeout(timer)
}

export function statusFor(key: string): LiveStatus | undefined {
  const entry = entries.get(key)
  return entry == null ? undefined : toStatus(entry)
}

export function liveKeys(): string[] {
  return [...entries.keys()]
}

/**
 * Outputs -------------------------------------------------------------------
 */

function ingressUrl(entry: LiveEntry): string {
  const { bindHost, port, app } = requireConfig()
  const path = entry.ingress.path ?? `${app}/${entry.key}`
  // Always the loopback, whatever the ingest binds: this child is on the same
  // machine, and reading from a public address would leave the split at the
  // mercy of the host's own firewall.
  const host = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost
  return `rtmp://${host}:${port}/${path}`
}

function argsFor(entry: LiveEntry, output: OutputRuntime): string[] {
  const base = [
    '-hide_banner',
    '-loglevel',
    'info',
    // How many bytes have actually gone out, read from ffmpeg's own
    // machine-readable progress rather than from the line it draws for a
    // person. That line is not printed at all when stderr is a pipe in newer
    // builds, which is why an output that was working reported nought bytes a
    // second for ever. `total_size` has meant the same thing for a decade.
    '-progress',
    'pipe:1',
    '-stats_period',
    '1',
    '-i',
    ingressUrl(entry)
  ]
  if (output.kind === 'rtmp') {
    return [
      ...base,
      '-c',
      'copy',
      '-f',
      'flv',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '10',
      output.target
    ]
  }

  // The HLS leg. `temp_file` so a half-written segment is never served,
  // `program_date_time` so every segment says when it was written, and
  // `omit_endlist` because the end of a game is the controller's to declare,
  // not the end of one connection's (see `draining`).
  //
  // A restart adds `append_list`, so the stream continues the playlist it
  // already has rather than starting a new one. That alone marks the join
  // with an `EXT-X-DISCONTINUITY`: the publisher's encoder started again, and
  // a player told so resets its decoder instead of decoding across the gap.
  // `discont_start` is left off, because on top of that it writes another one
  // above the first segment on each restart, which changes the playlist above
  // segments a player already has, and an `EVENT` playlist may only grow at
  // the end.
  //
  // Two numbers make the continuation seamless to a player that kept the
  // playlist across the restart:
  //
  // - `-start_number` is the playlist's own first sequence number, not the
  //   next free one. FFmpeg writes `EXT-X-MEDIA-SEQUENCE` from it and names
  //   the new segments after it plus the segments already listed. Handing it
  //   the next free number renumbered every segment already in the playlist,
  //   and a player that held it took them for new ones and played the start
  //   of the game again after the break.
  // - `-output_ts_offset` is the playlist's length so far, so the new
  //   segments' own timestamps carry on from where the last ones stopped
  //   instead of starting again at nought. The recording made from these
  //   segments then needs no guess about where each part goes.
  const flags = [
    'independent_segments',
    'temp_file',
    'program_date_time',
    'omit_endlist'
  ]
  const restart = output.hlsRestarted === true
  if (restart) flags.push('append_list')
  const offsetSec = output.continuation?.offsetSec ?? 0
  const directory = output.target.slice(
    0,
    output.target.length - LIVE_PLAYLIST_NAME.length - 1
  )
  return [
    ...base,
    '-c',
    'copy',
    ...(restart && offsetSec > 0
      ? ['-output_ts_offset', offsetSec.toFixed(6)]
      : []),
    // Safari refuses HEVC tagged `hev1`, which is what a copy from RTMP is
    // tagged by default, so every HLS track here is tagged `hvc1`. It is also
    // why an H.264 publish is turned away rather than written: this tag and
    // that codec cannot both be true.
    '-tag:v',
    'hvc1',
    '-f',
    'hls',
    '-hls_time',
    String(requireConfig().segmentSeconds),
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    // A sound track that starts after the picture keeps its RTMP time rather
    // than being stamped from 0 s.
    ...KEEP_STREAM_TIMES,
    '-hls_flags',
    flags.join('+'),
    '-start_number',
    String(output.continuation?.startNumber ?? 0),
    '-hls_segment_filename',
    `${directory}/seg%06d.m4s`,
    output.target
  ]
}

const CONNECTED_LINE_RE = /Output\s+#0,\s*(flv|hls),\s*to\s+'/
const PROGRESS_LINE_RE = /\bframe=\s*\d+/
const ERROR_LINE_RE =
  /(Connection refused|Connection timed out|No route to host|I\/O error|Server returned|Failed to update header|RTMP_Connect|TLS_send|Unknown error|HTTP error|Invalid data found|does not contain any stream)/i

/** `size=  1024KiB` and its older spellings, in bytes. */
function parseSize(token: string, unit: string): number {
  const n = parseInt(token, 10)
  if (!Number.isFinite(n)) return 0
  switch (unit.toLowerCase()) {
    case 'kb':
    case 'kib':
      return n * 1024
    case 'mb':
    case 'mib':
      return n * 1024 * 1024
    case 'gb':
    case 'gib':
      return n * 1024 * 1024 * 1024
    default:
      return n
  }
}

function spawnOutput(entry: LiveEntry, output: OutputRuntime): void {
  const { ffmpegPath, log } = requireConfig()
  if (output.restartTimer != null) {
    clearTimeout(output.restartTimer)
    output.restartTimer = undefined
  }
  // A spawn after a stop means the stream is wanted again. Cancel the pending
  // escalation, or it would SIGKILL the child about to be registered.
  if (output.killEscalationTimer != null) {
    clearTimeout(output.killEscalationTimer)
    output.killEscalationTimer = undefined
  }
  if (output.released) return
  // Two ffmpeg writing one playlist would corrupt it, so a respawn waits for
  // the draining writer to finish. Its exit handler picks this up.
  if (output.draining === true && output.child != null) {
    output.pendingRespawn = true
    return
  }

  // A writer starting where one has already been must continue that playlist,
  // not start it again. Read from the directory rather than remembered,
  // because the writer before it may have ended in any of several ways — the
  // publisher dropping, a crash, this whole process being restarted — and the
  // segments on disk are the one account of what happened that survives all
  // of them. Getting this wrong silently overwrites the first half of a game
  // with the second.
  if (output.kind === 'hls') {
    const next = nextSegmentNumber(entry.hlsDir)
    if (next > 0) {
      output.hlsRestarted = true
      reopenPlaylist(entry.hlsDir)
      settleLastSegment(entry.hlsDir)
      output.continuation = playlistContinuation(
        readPlaylist(entry.hlsDir),
        next
      )
    }
  }

  const args = argsFor(entry, output)
  log(`[live:${entry.liveStreamId}] ffmpeg → ${output.label}`)
  let child: ChildProcess
  try {
    child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    output.state = 'error'
    output.lastError = `failed to spawn ffmpeg: ${String(error)}`
    report(entry)
    return
  }
  output.child = child
  output.spawned.add(child)
  output.state = 'connecting'
  output.startedAt = Date.now()
  output.lastError = undefined
  report(entry)

  let buffer = ''
  const onLine = (line: string): void => {
    if (line.length === 0) return
    if (
      output.state !== 'connected' &&
      (CONNECTED_LINE_RE.test(line) || PROGRESS_LINE_RE.test(line))
    ) {
      output.state = 'connected'
      output.lastError = undefined
      report(entry)
    }
    // `total_size=12345` and `out_time_us=…` from `-progress`, which is the
    // whole point of it. An HLS output answers `N/A` to the first, because it
    // writes a file per segment, and the second is what says it is advancing.
    const trimmed = line.trim()
    const progress = /^total_size=(\d+)$/.exec(trimmed)
    if (progress != null) {
      output.bytesWritten = Number.parseInt(progress[1], 10)
    }
    const written = /^out_time_us=(\d+)$/.exec(trimmed)
    if (written != null) {
      output.recordedSec = Number.parseInt(written[1], 10) / 1_000_000
    }
    if ((progress != null || written != null) && output.state !== 'connected') {
      output.state = 'connected'
      output.lastError = undefined
      report(entry)
    }

    // And the human line as well, for a build that still draws one. Every
    // `size=` in it, not the first: ffmpeg overwrites that line with a
    // carriage return, so one read can hold several updates and only the last
    // is current.
    let lastSize: number | undefined
    const sizeRe = /size=\s*(\d+)([kKMG]?i?B)/g
    let match: RegExpExecArray | null
    while ((match = sizeRe.exec(line)) != null) {
      lastSize = parseSize(match[1], match[2])
    }
    if (lastSize != null && progress == null) output.bytesWritten = lastSize
    if (ERROR_LINE_RE.test(line)) {
      output.state = 'error'
      output.lastError = line.trim().slice(0, 256)
      report(entry)
    }
  }
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8')
    let at = buffer.search(/[\r\n]/)
    while (at !== -1) {
      onLine(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      at = buffer.search(/[\r\n]/)
    }
  }
  child.stderr?.on('data', onData)
  child.stdout?.on('data', onData)

  let exitHandled = false
  child.on('exit', (code, signal) => {
    // Node has been seen to emit `exit` more than once for one child. The
    // first is canonical; the rest would double-count a restart.
    if (exitHandled) return
    exitHandled = true
    const pid = child.pid
    log(
      `[live:${entry.liveStreamId}] ffmpeg for ${output.label} exited code=${String(code)} signal=${String(signal)}`
    )

    // Node says it died; the OS says otherwise. Kill it and keep tracking it,
    // rather than forgetting an ffmpeg that is still pushing video somewhere.
    if (isPidAlive(pid)) {
      log(`[live:${entry.liveStreamId}] phantom exit pid=${String(pid)}`)
      killByPid(pid, 'SIGKILL')
      report(entry)
      return
    }
    output.spawned.delete(child)
    // An older child's exit, arriving after a newer one took over. Stop
    // tracking it, but leave the state machine to the current child.
    if (output.child !== child) {
      report(entry)
      return
    }
    output.child = undefined

    if (output.draining === true) {
      output.draining = false
      if (output.drainTimer != null) {
        clearTimeout(output.drainTimer)
        output.drainTimer = undefined
      }
      // The publisher came back while this one was finishing. Now that the
      // playlist has one writer again, the next part can be appended to it.
      if (output.pendingRespawn === true && !output.released) {
        output.pendingRespawn = false
        spawnOutput(entry, output)
        return
      }
    }

    if (output.released || output.state === 'stopped') {
      report(entry)
      return
    }
    if (!entry.ingress.publishing) {
      output.state = 'stopped'
      report(entry)
      return
    }
    if (code !== 0 && (output.lastError == null || output.lastError === '')) {
      output.lastError = `ffmpeg exited with code ${String(code)}`
    }
    const again = restartDelay(
      output.restartCount,
      Date.now() - (output.startedAt ?? 0)
    )
    output.restartCount = again.nextCount
    output.state = 'connecting'
    report(entry)
    output.restartTimer = setTimeout(() => {
      spawnOutput(entry, output)
    }, again.delayMs)
  })
  child.on('error', error => {
    output.state = 'error'
    output.lastError = `spawn error: ${String(error)}`
    report(entry)
  })
}

/**
 * The segment number to carry on from, read off the directory rather than
 * remembered, so a restart of the server itself still appends in order.
 */
export function nextSegmentNumber(directory: string): number {
  try {
    let highest = -1
    for (const name of readdirSync(directory)) {
      const match = /^seg(\d+)\.m4s$/.exec(name)
      if (match == null) continue
      highest = Math.max(highest, parseInt(match[1], 10))
    }
    return highest + 1
  } catch {
    return 0
  }
}

/** Where a writer appending to a playlist carries on from. */
export interface Continuation {
  /** What `-start_number` must be for the playlist's numbering to hold. */
  startNumber: number
  /** The playlist's length so far, which the new timestamps start from. */
  offsetSec: number
}

/**
 * Where a writer appending to `playlist` carries on from.
 *
 * FFmpeg's `append_list` writes `EXT-X-MEDIA-SEQUENCE` as `-start_number` and
 * names each new segment `-start_number` plus the segments it found listed,
 * so the start number that keeps the numbering is the playlist's own media
 * sequence. A playlist whose numbering an older writer already broke (the
 * segment names running ahead of their sequence numbers) gets the smallest
 * start that still names every new segment after the last one listed:
 * overwriting a listed segment would lose part of the game, which is worse
 * than a jump in the numbering.
 *
 * With no playlist, or one listing nothing, it starts after the segments on
 * the disk, `nextOnDisk`, as it always did.
 */
export function playlistContinuation(
  playlist: string | undefined,
  nextOnDisk: number
): Continuation {
  if (playlist == null) return { startNumber: nextOnDisk, offsetSec: 0 }
  let mediaSequence = 0
  let listed = 0
  let highest = -1
  let offsetSec = 0
  for (const raw of playlist.split('\n')) {
    const line = raw.trim()
    const sequence = /^#EXT-X-MEDIA-SEQUENCE:(\d+)$/.exec(line)
    if (sequence != null) mediaSequence = Number.parseInt(sequence[1], 10)
    const duration = /^#EXTINF:([\d.]+)/.exec(line)
    if (duration != null) offsetSec += Number.parseFloat(duration[1])
    const segment = /^seg(\d+)\.m4s$/.exec(line)
    if (segment != null) {
      listed += 1
      highest = Math.max(highest, Number.parseInt(segment[1], 10))
    }
  }
  if (listed === 0) return { startNumber: nextOnDisk, offsetSec: 0 }
  return {
    startNumber: Math.max(mediaSequence, highest + 1 - listed),
    // To the microsecond, as FFmpeg writes the durations.
    offsetSec: Math.round(offsetSec * 1_000_000) / 1_000_000
  }
}

/**
 * Lists the playlist's last segment at its true length.
 *
 * FFmpeg lists the last segment a writer closes as running to the start of
 * its last picture, a frame short of its end. Appended to as it stands, the
 * next part starts a frame early, under that last picture: a player that
 * loads the playlist afresh puts the next part where the playlist says, one
 * that played up to the break puts it after the picture it already has, and
 * the two disagree by a frame for the rest of the game. Measured from the
 * segment itself, the length is the same for both, and the new part's
 * timestamps (`-output_ts_offset`) start exactly where it ends.
 *
 * Only a small correction is made, to the last segment, and only once its
 * samples have been read; anything it cannot read is left as it is.
 */
export function settleLastSegment(directory: string): void {
  const path = `${directory}/${LIVE_PLAYLIST_NAME}`
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    let segmentAt = -1
    for (let at = lines.length - 1; at >= 0 && segmentAt < 0; at--) {
      if (/^seg\d+\.m4s$/.test(lines[at].trim())) segmentAt = at
    }
    let durationAt = -1
    for (let at = segmentAt - 1; at >= 0 && durationAt < 0; at--) {
      if (lines[at].startsWith('#EXTINF:')) durationAt = at
    }
    if (durationAt < 0) return
    const listed = Number.parseFloat(lines[durationAt].slice('#EXTINF:'.length))
    const real = segmentPictureSec(
      readFileSync(`${directory}/init.mp4`),
      readFileSync(`${directory}/${lines[segmentAt].trim()}`)
    )
    if (real == null || real <= 0) return
    const off = Math.abs(real - listed)
    if (off < 0.0005 || off > 1) return
    lines[durationAt] = `#EXTINF:${real.toFixed(6)},`
    writeFileSync(path, lines.join('\n'))
  } catch {
    // No playlist, or no segment to read: nothing to correct.
  }
}

function readPlaylist(directory: string): string | undefined {
  try {
    return readFileSync(`${directory}/${LIVE_PLAYLIST_NAME}`, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Takes the `EXT-X-ENDLIST` off a playlist that is about to be written to
 * again.
 *
 * The controller closed the playlist, because the publisher had stayed away
 * past the reconnect grace — and now it is back. A player reading a playlist
 * with an `ENDLIST` in the middle stops there, so the rest of the game would
 * exist on disk and be unwatchable.
 */
export function reopenPlaylist(directory: string): void {
  const path = `${directory}/${LIVE_PLAYLIST_NAME}`
  try {
    const playlist = readFileSync(path, 'utf8')
    if (!playlist.includes('#EXT-X-ENDLIST')) return
    writeFileSync(
      path,
      playlist.replace(/#EXT-X-ENDLIST\s*$/, '').replace(/\n+$/, '\n')
    )
  } catch {
    // No playlist, or no permission to rewrite it. The spawn that follows will
    // say so far more loudly than this could.
  }
}

function startOutputs(entry: LiveEntry): void {
  for (const output of entry.outputs) spawnOutput(entry, output)
}

/**
 * Stops the outputs, letting the HLS writer close its own playlist when the
 * stream simply ended. A revocation or a reconfigure passes `drain: false`,
 * because there the point is that nothing more is written at all.
 */
function stopOutputs(entry: LiveEntry, reason: string, drain = false): void {
  for (const output of entry.outputs) {
    if (drain && output.kind === 'hls' && output.child != null) {
      drainOutput(output)
      continue
    }
    stopOutput(output)
  }
  requireConfig().log(
    `[live:${entry.liveStreamId}] outputs stopped (${reason})`
  )
}

/**
 * Lets a writer finish. Its state says `stopped` so nothing restarts it, and a
 * timer takes it if the end of the stream never reaches it — which happens
 * when the publisher's socket died rather than closed.
 */
function drainOutput(output: OutputRuntime): void {
  if (output.restartTimer != null) {
    clearTimeout(output.restartTimer)
    output.restartTimer = undefined
  }
  output.state = 'stopped'
  output.bytesPerSecond = 0
  output.draining = true
  if (output.drainTimer != null) clearTimeout(output.drainTimer)
  output.drainTimer = setTimeout(() => {
    output.drainTimer = undefined
    if (output.draining !== true) return
    output.draining = false
    stopOutput(output)
  }, HLS_DRAIN_MS)
  output.drainTimer.unref?.()
}

function stopOutput(output: OutputRuntime): void {
  if (output.restartTimer != null) {
    clearTimeout(output.restartTimer)
    output.restartTimer = undefined
  }
  if (output.drainTimer != null) {
    clearTimeout(output.drainTimer)
    output.drainTimer = undefined
  }
  output.draining = false
  output.pendingRespawn = false
  output.state = 'stopped'
  output.bytesPerSecond = 0
  // SIGTERM every tracked child, not only the current one: a phantom exit may
  // have left survivors that nothing else can reach.
  for (const child of output.spawned) {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }
  // Snapshot now. If a publisher reconnects between the SIGTERM and the
  // escalation, the new child must not be killed by this timer.
  const toEscalate = [...output.spawned]
  if (output.killEscalationTimer != null) {
    clearTimeout(output.killEscalationTimer)
  }
  output.killEscalationTimer = setTimeout(() => {
    output.killEscalationTimer = undefined
    for (const child of toEscalate) {
      if (isPidAlive(child.pid)) killByPid(child.pid, 'SIGKILL')
    }
  }, SIGKILL_GRACE_MS)
  output.killEscalationTimer.unref?.()
}

/**
 * Retires the current outputs for good. Anything still holding one of these
 * objects — a restart timer, an exit handler — will find it released and do
 * nothing, which is what keeps a turned-off destination turned off.
 */
function releaseOutputs(entry: LiveEntry, reason: string): void {
  for (const output of entry.outputs) {
    output.released = true
    stopOutput(output)
  }
  if (entry.outputs.length > 0) {
    requireConfig().log(
      `[live:${entry.liveStreamId}] outputs released (${reason})`
    )
  }
}

/**
 * Clears a publisher without waiting for node-media-server to notice it has
 * gone, in three layered attempts: end the socket, destroy the socket, then
 * tell the broadcast server directly. Our own state is reset *first*, so the
 * donePublish that any of the three may trigger is already a no-op.
 *
 * Outbounds are deliberately not touched here. The stale-publisher path wants
 * them merely stopped, so a reconnect brings them straight back; a revocation
 * wants them released. Deciding that here would make the two indistinguishable.
 */
function forceCloseIngress(entry: LiveEntry, reason: string): void {
  const session = entry.ingress.session
  entry.ingress.publishing = false
  entry.ingress.receivingPackets = false
  entry.ingress.bytesPerSecond = 0
  entry.ingress.zeroByteTicks = 0
  entry.ingress.session = undefined
  if (session == null) return
  requireConfig().log(
    `[live:${entry.liveStreamId}] closing publisher ${session.id} (${reason})`
  )
  try {
    session.close?.()
  } catch {
    // Each step is tried regardless of what the last one did.
  }
  try {
    session.socket?.destroy?.()
  } catch {
    // As above.
  }
  try {
    session.broadcast?.donePublish?.(session)
  } catch {
    // As above.
  }
}

/**
 * One second of housekeeping: byte rates, dead children swept, and the
 * publisher that stopped sending anything at all.
 */
function pollSampler(): void {
  for (const entry of entries.values()) {
    const ingress = entry.ingress
    let dirty = false
    const currentInBytes = ingress.session?.inBytes ?? 0
    if (ingress.publishing) {
      if (ingress.codecChecked !== true && ingress.session != null) {
        const refusal = codecRefusal(ingress.session.videoCodec)
        if (refusal != null) {
          ingress.codecChecked = true
          requireConfig().log(`[live:${entry.liveStreamId}] ${refusal}`)
          requireConfig().onEvent({
            type: 'rejected',
            key: entry.key,
            reason: refusal
          })
          endSubscribers(ingress.session)
          forceCloseIngress(entry, refusal)
          stopOutputs(entry, refusal)
          requireConfig().onEvent({
            type: 'publishEnded',
            key: entry.key,
            liveStreamId: entry.liveStreamId,
            reason: refusal
          })
          report(entry)
          continue
        }
        // Either it is HEVC, or the metadata has not arrived yet and the next
        // tick will look again.
        if (
          ingress.session.videoCodec != null &&
          ingress.session.videoCodec !== 0
        ) {
          ingress.codecChecked = true
        }
      }
      const delta = currentInBytes - ingress.bytesAtLastTick
      ingress.bytesPerSecond = delta > 0 ? delta : 0
      ingress.bytesAtLastTick = currentInBytes
      ingress.bytesReceived = currentInBytes
      const receiving = ingress.bytesPerSecond > 0
      if (receiving !== ingress.receivingPackets) {
        ingress.receivingPackets = receiving
        dirty = true
      }
      if (ingress.bytesPerSecond > 0) {
        dirty = true
        ingress.zeroByteTicks = 0
      } else {
        ingress.zeroByteTicks += 1
        if (ingress.zeroByteTicks >= STALE_INGRESS_TICKS) {
          requireConfig().log(
            `[live:${entry.liveStreamId}] publisher sent nothing for ${ingress.zeroByteTicks}s; closing it`
          )
          // Stopped, not released: when the encoder reconnects — which is what
          // usually happens next — the same outputs pick straight back up.
          if (ingress.session != null) endSubscribers(ingress.session)
          forceCloseIngress(entry, 'stale publisher')
          stopOutputs(entry, 'stale publisher', true)
          requireConfig().onEvent({
            type: 'publishEnded',
            key: entry.key,
            liveStreamId: entry.liveStreamId,
            reason: 'The stream stopped sending video'
          })
          report(entry)
          continue
        }
      }
    } else if (
      ingress.bytesPerSecond !== 0 ||
      ingress.receivingPackets ||
      ingress.zeroByteTicks !== 0
    ) {
      ingress.bytesPerSecond = 0
      ingress.receivingPackets = false
      ingress.zeroByteTicks = 0
      dirty = true
    }

    for (const output of entry.outputs) {
      // The canonical place a phantom-exit survivor is finally forgotten.
      for (const child of output.spawned) {
        if (!isPidAlive(child.pid)) output.spawned.delete(child)
      }
      const delta = output.bytesWritten - output.bytesAtLastTick
      const rate = delta > 0 ? delta : 0
      output.bytesAtLastTick = output.bytesWritten
      if (rate !== output.bytesPerSecond) {
        output.bytesPerSecond = rate
        if (rate > 0) dirty = true
      }
    }
    if (dirty) report(entry)
  }
}

/**
 * Bootstrap -----------------------------------------------------------------
 */

/**
 * Ends the sessions reading a stream. Ours are the ffmpeg children; there is
 * never anybody else on the RTMP side.
 */
/**
 * Why a stream is not one we can take, or `null` when it is.
 *
 * TeamStation stores HEVC and nothing else, and both legs of the split are a
 * copy — so a stream in the wrong codec cannot be salvaged downstream, and the
 * only kind thing to do is say so at once rather than record something no
 * browser here will play.
 */
export function codecRefusal(
  codec: number | string | undefined
): string | null {
  if (codec == null || codec === 0 || codec === '') return null
  const name = codecName(codec)
  if (name === 'hvc1' || name === 'hev1') return null
  if (name === 'avc1') {
    return 'TeamStation takes HEVC. This stream is H.264 — change the encoder to HEVC and start it again.'
  }
  return `TeamStation takes HEVC. This stream is ${name}, which it cannot store.`
}

/**
 * What a stream says it is carrying, as a four-character code.
 *
 * Three spellings reach us for the same fact. Classic FLV numbers a handful of
 * codecs — 7 is H.264, 12 is HEVC. Enhanced RTMP replaced that with a
 * four-character code, which arrives here as the **integer those four bytes
 * make**: HEVC is 1752589105, which is `hvc1` read as a big-endian number. And
 * some publishers send the characters themselves.
 *
 * Reading that number as a small codec id is what turned a perfectly good
 * HEVC stream away, so every form is folded into one here.
 */
export function codecName(codec: number | string): string {
  if (typeof codec === 'string') return codec.trim().toLowerCase()
  if (codec === 7) return 'avc1'
  if (codec === 12) return 'hvc1'
  if (codec > 0xffff) {
    return String.fromCharCode(
      (codec >>> 24) & 0xff,
      (codec >>> 16) & 0xff,
      (codec >>> 8) & 0xff,
      codec & 0xff
    ).toLowerCase()
  }
  return `codec ${String(codec)}`
}

function endSubscribers(session: NmsSession): void {
  const subscribers = session.broadcast?.subscribers
  if (subscribers == null) return
  for (const subscriber of subscribers.values()) {
    try {
      subscriber.close?.()
    } catch {
      // The drain timer takes anything that will not go.
    }
  }
}

/**
 * Whether the publisher on a key has stopped being the stream: nothing has
 * arrived for TAKEOVER_SILENT_TICKS, and nothing since the last tick either.
 */
function hasGoneQuiet(ingress: IngressRuntime): boolean {
  const session = ingress.session
  if (session == null) return true
  if ((session.inBytes ?? 0) > ingress.bytesAtLastTick) return false
  return ingress.zeroByteTicks >= TAKEOVER_SILENT_TICKS
}

/**
 * Lets a new publish on a key replace a publisher that has gone quiet.
 *
 * Runs inside node-media-server's `postPublish`, which it fires *before* its
 * own "already has a publisher" check: the quiet publisher is released here,
 * so that check finds the key free and lets the newcomer through. The outputs
 * are stopped rather than released, exactly as for a stale publisher, so the
 * newcomer's accept brings the same HLS writer back and the video goes on in
 * the same playlist.
 */
function replaceQuietPublisher(entry: LiveEntry, session: NmsSession): void {
  const ingress = entry.ingress
  const old = ingress.session
  if (old == null || old === session || !ingress.publishing) return
  if (!hasGoneQuiet(ingress)) return
  const { log, onEvent } = requireConfig()
  log(
    `[live:${entry.liveStreamId}] publisher ${old.id} sent nothing for ${ingress.zeroByteTicks}s; ${session.id} replaces it`
  )
  endSubscribers(old)
  forceCloseIngress(entry, 'replaced by a new publish')
  stopOutputs(entry, 'publisher replaced', true)
  onEvent({
    type: 'publishEnded',
    key: entry.key,
    liveStreamId: entry.liveStreamId,
    reason: 'The camera reconnected'
  })
  report(entry)
}

/**
 * Takes a publisher on.
 *
 * node-media-server fires `postPublish` *before* its own "already has a
 * publisher" check, so a second encoder lands here even though the new
 * session is about to be rejected. Keeping the first one is what stops two
 * sets of ffmpeg children fighting over one destination key. A first one that
 * had gone quiet was already replaced by `replaceQuietPublisher`.
 */
function accept(entry: LiveEntry, session: NmsSession): void {
  const { log, onEvent } = requireConfig()
  if (entry.ingress.session != null && entry.ingress.publishing) {
    log(`[live:${entry.liveStreamId}] second publisher ignored`)
    return
  }
  log(`[live:${entry.liveStreamId}] publisher connected`)
  entry.ingress.path = publishPath(session)
  entry.ingress.session = session
  entry.ingress.publishing = true
  entry.ingress.bytesAtLastTick = session.inBytes ?? 0
  entry.ingress.bytesReceived = session.inBytes ?? 0
  entry.ingress.receivingPackets = false
  entry.ingress.bytesPerSecond = 0
  entry.ingress.zeroByteTicks = 0
  onEvent({
    type: 'publishStarted',
    key: entry.key,
    liveStreamId: entry.liveStreamId
  })
  report(entry)
  startOutputs(entry)
}

/**
 * Turns a publisher away: an unknown key, a revoked one, or one whose window
 * has closed. Said out loud once, because from the encoder's end every refusal
 * looks the same as a network fault.
 */
function refuse(
  session: NmsSession,
  key: string,
  reason = 'unknown key'
): void {
  const { log, onEvent } = requireConfig()
  log(`[live] refused a publish: ${reason}`)
  onEvent({ type: 'rejected', key, reason })
  try {
    session.close?.()
  } catch {
    // Nothing more to do about it.
  }
  try {
    session.socket?.destroy?.()
  } catch {
    // As above.
  }
}

/**
 * The key, however the encoder spelled the address.
 *
 * TS Director and ffmpeg publish to `rtmp://host:port/live/<key>`, which
 * arrives as the app `live` and the stream `<key>`. Streaming software that
 * asks for a **server** and a **key** in two boxes — OBS, most of them —
 * leaves somebody who was handed one URL pasting the whole thing into the
 * server box and nothing into the other, and that arrives as the app
 * `live/<key>` with no stream name at all. It is the same intention, and
 * answering one of them with silence is how an operator loses an afternoon.
 *
 * `undefined` means the publish is not ours to answer for at all.
 */
/**
 * The path the stream is actually published under, exactly as the server has
 * it — trailing slash and all.
 *
 * Not tidied: a reader has to ask for the same string the publisher used, and
 * `/live/<key>/` and `/live/<key>` are two different streams to an RTMP
 * server. `streamPath` is what it matched on, so it is what to subscribe to.
 */
function publishPath(session: NmsSession): string | undefined {
  const path = session.streamPath ?? ''
  if (path !== '') return path.replace(/^\/+/, '')
  const app = session.streamApp ?? ''
  const name = session.streamName ?? ''
  if (app === '') return undefined
  return name === '' ? app : `${app}/${name}`
}

export function keyFromSession(
  session: { streamApp?: string; streamName?: string },
  app: string
): string | undefined {
  const streamApp = (session.streamApp ?? '').replace(/\/+$/, '')
  const name = (session.streamName ?? '').replace(/\/+$/, '')
  if (streamApp === app) return name
  if (!streamApp.startsWith(`${app}/`)) return undefined
  // `live/<key>` with the key box left empty. Anything deeper than that is an
  // address we do not understand, and guessing at it would be worse.
  return name === '' ? streamApp.slice(app.length + 1) : undefined
}

/**
 * node-media-server's `postPublish`: a publish has started on some path.
 *
 * Synchronous up to the lookup, because the server checks for a publisher
 * already on the path the moment this returns: a quiet one has to be released
 * before then for the newcomer to get through.
 */
function publishArrived(session: NmsSession): void {
  const { app, log } = requireConfig()
  const key = keyFromSession(session, app)
  if (key == null) return
  if (!isPublishableKey(key)) {
    refuse(session, '')
    return
  }
  const entry = entries.get(key)
  if (entry != null) replaceQuietPublisher(entry, session)
  const resolve = requireConfig().resolve
  // Cached keys also need current authority before each new connection.
  if (entry != null && resolve == null) {
    accept(entry, session)
    return
  }
  if (resolve == null) {
    refuse(session, key)
    return
  }
  // Resolve both fresh and cached keys; the controller checks current authority.
  resolve(key).then(
    spec => {
      if (spec == null) {
        refuse(session, key)
        return
      }
      // A sentence rather than a stream: the key is real and this publish is
      // still not allowed — no room on the disk, most likely — and the
      // person holding the encoder is owed the reason.
      if (typeof spec === 'string') {
        refuse(session, key, spec)
        return
      }
      setLive(key, spec)
      const resolved = entries.get(key)
      if (resolved == null) {
        refuse(session, key)
        return
      }
      accept(resolved, session)
    },
    (error: unknown) => {
      log(`[live] could not look a key up: ${String(error)}`)
      refuse(session, key)
    }
  )
}

/** node-media-server's `donePublish`: the publisher on a path has gone. */
function publishGone(session: NmsSession): void {
  const { app, log } = requireConfig()
  const key = keyFromSession(session, app)
  const entry =
    key != null && isPublishableKey(key) ? entries.get(key) : undefined
  if (entry == null) return
  if (entry.ingress.session !== session) return
  log(`[live:${entry.liveStreamId}] publisher disconnected`)
  // The server keeps a reader connected after its publisher has gone, so
  // ffmpeg would sit waiting for video that is never coming and have to be
  // killed — losing the segment it was part way through, which is the last
  // few seconds of the game. Ending the reader gives it the end of the
  // stream instead, and it closes its own playlist.
  endSubscribers(session)
  entry.ingress.publishing = false
  entry.ingress.receivingPackets = false
  entry.ingress.bytesPerSecond = 0
  entry.ingress.zeroByteTicks = 0
  entry.ingress.session = undefined
  stopOutputs(entry, 'publisher disconnected', true)
  requireConfig().onEvent({
    type: 'publishEnded',
    key: entry.key,
    liveStreamId: entry.liveStreamId,
    reason: 'The stream ended'
  })
  report(entry)
}

export function startIngest(): boolean {
  const { bindHost, port, app, log } = requireConfig()
  if (nmsInstance != null) return true

  let NodeMediaServer: NmsCtor
  try {
    NodeMediaServer = require('node-media-server') as NmsCtor
  } catch (error) {
    log(
      `live ingest disabled: node-media-server did not load: ${String(error)}`
    )
    return false
  }

  try {
    nmsInstance = new NodeMediaServer({ bind: bindHost, rtmp: { port } })
  } catch (error) {
    log(`live ingest disabled: ${String(error)}`)
    return false
  }

  nmsInstance.on('postPublish', publishArrived)
  nmsInstance.on('donePublish', publishGone)

  try {
    nmsInstance.run()
  } catch (error) {
    log(`live ingest failed to start: ${String(error)}`)
    nmsInstance = undefined
    return false
  }

  pollTimer = setInterval(pollSampler, SAMPLE_INTERVAL_MS)
  pollTimer.unref?.()
  log(`live ingest on rtmp://${bindHost}:${port}/${app}/{key}`)
  return true
}

/**
 * Stops the ingest and lets go of every child.
 *
 * A process killed outright rather than stopped does not run this — and does
 * not need to. Every child reads from this process's own RTMP port, so the
 * moment it dies their input dies with it and they exit on the end of the
 * stream. That is what keeps a `kill -9` from leaving two writers on one
 * playlist when the server comes back.
 */
export function stopIngest(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  for (const entry of entries.values()) {
    releaseOutputs(entry, 'shutdown')
  }
  entries.clear()
  try {
    nmsInstance?.stop?.()
  } catch {
    // Going away anyway.
  }
  nmsInstance = undefined
}

/**
 * Test hooks ----------------------------------------------------------------
 *
 * The state machine is the part worth testing and the RTMP server is not, so
 * these drive it directly: a tick of the sampler without a second of real
 * time, a publisher without a socket, and a session without a network.
 */

export function tickSamplerForTest(): void {
  pollSampler()
}

export function attachSessionForTest(
  key: string,
  session: {
    id: string
    inBytes?: number
    close?: () => void
    socket?: { destroy?: () => void }
    broadcast?: { donePublish?: (session: unknown) => void }
  }
): void {
  const entry = entries.get(key)
  if (entry == null) return
  entry.ingress.session = session
}

/** A session as node-media-server reports it, for the hooks below. */
export interface TestSession {
  id: string
  streamApp?: string
  streamName?: string
  streamPath?: string
  inBytes?: number
  close?: () => void
  socket?: { destroy?: () => void }
  broadcast?: {
    donePublish?: (session: never) => void
    subscribers?: Map<string, { close?: () => void }>
  }
}

/** node-media-server's `postPublish`, without the server. */
export function publishArrivedForTest(session: TestSession): void {
  publishArrived(session as NmsSession)
}

/** node-media-server's `donePublish`, without the server. */
export function publishGoneForTest(session: TestSession): void {
  publishGone(session as NmsSession)
}

export function forcePublishForTest(key: string, publishing: boolean): void {
  const entry = entries.get(key)
  if (entry == null) return
  if (publishing && !entry.ingress.publishing) {
    entry.ingress.publishing = true
    entry.ingress.bytesAtLastTick = 0
    entry.ingress.bytesReceived = 0
    entry.ingress.receivingPackets = false
    entry.ingress.bytesPerSecond = 0
    entry.ingress.zeroByteTicks = 0
    requireConfig().onEvent({
      type: 'publishStarted',
      key: entry.key,
      liveStreamId: entry.liveStreamId
    })
    startOutputs(entry)
  } else if (!publishing && entry.ingress.publishing) {
    entry.ingress.publishing = false
    entry.ingress.receivingPackets = false
    entry.ingress.bytesPerSecond = 0
    entry.ingress.zeroByteTicks = 0
    stopOutputs(entry, 'test publisher disconnected', true)
    requireConfig().onEvent({
      type: 'publishEnded',
      key: entry.key,
      liveStreamId: entry.liveStreamId,
      reason: 'The stream ended'
    })
  }
}

/** Test-only: forget everything, so one test cannot see another's streams. */
export function resetForTest(): void {
  for (const entry of entries.values()) releaseOutputs(entry, 'test reset')
  entries.clear()
  if (pollTimer != null) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}
