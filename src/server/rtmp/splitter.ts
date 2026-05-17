import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import type { WebSocket } from 'ws'

import type {
  SplitIngressStatus,
  SplitOutboundState,
  SplitOutboundStatus,
  SplitStatus,
  SplitStatusMessage
} from '../../common/types'
import { serverConfig } from '../serverConfig'
import { logger } from '../util/utils'

// Lazy require for node-media-server so we don't need TS types and so
// missing-system-dep failures show up as a runtime error rather than a
// type-check error.
interface NmsSession {
  id: string
  streamApp?: string
  streamName?: string
  streamPath?: string
  inBytes?: number
  isPublisher?: boolean
  // RtmpSession.close() ends the underlying TCP socket, which (when the
  // socket is healthy) cascades through onClose -> broadcast.donePublish
  // -> our donePublish event handler, releasing NMS's "already has a
  // publisher" lock for this streamPath.
  close?: () => void
  // The raw net.Socket. Exposed for the rare case where close() is a
  // no-op because the socket is already half-closed (e.g. zombie session
  // whose TCP peer died without FIN/RST), and we need to forcibly
  // destroy() it to make Node fire the close event.
  socket?: { destroy?: () => void }
  // The BroadcastServer instance NMS attaches to a publishing session in
  // RtmpSession.onConnect. Calling .donePublish(session) directly on it
  // releases the streamPath publisher lock even when the socket-close
  // path doesn't fire (it's idempotent: checks session === publisher).
  broadcast?: { donePublish?: (session: NmsSession) => void }
}
interface NmsInstance {
  on: (event: string, listener: (session: NmsSession) => void) => void
  run: () => void
}
type NmsCtor = new (config: Record<string, unknown>) => NmsInstance

interface OutboundRuntime {
  url: string
  state: SplitOutboundState
  lastError?: string
  bytesSent: number
  bytesPerSecond: number
  bytesAtLastTick: number
  restartCount: number
  // The ChildProcess instance the splitter currently considers the active
  // forwarder for this outbound. Its 'exit' is the one that triggers the
  // restart / state-machine logic. Earlier spawns that should have already
  // exited (or whose 'exit' event we no longer trust) are still tracked via
  // `spawned` below but are NOT this reference.
  child?: ChildProcess
  // Every ChildProcess we have spawned for this outbound and for which we
  // are not OS-confirmed dead yet.
  //
  // We can't fully trust child.on('exit'): in production we have observed
  // Node fire 'exit' for ffmpeg children whose OS process was still alive
  // (likely a libuv SIGCHLD reap race when many children exit in rapid
  // succession). When that happens the splitter previously cleared
  // outbound.child and forgot about the still-running ffmpeg, leaving an
  // orphan pushing to the destination forever.
  //
  // By keeping every spawned child here until pollSampler confirms its PID
  // is gone, stopOutbound / releaseOutbounds can reliably SIGTERM (and
  // escalate to SIGKILL) every survivor.
  spawned: Set<ChildProcess>
  restartTimer?: NodeJS.Timeout
  // After SIGTERM we schedule a SIGKILL escalation. ffmpeg can ignore
  // SIGTERM during certain blocking operations (TLS writes, in-flight
  // RTMP handshakes, etc.) so we don't rely on it to actually exit.
  killEscalationTimer?: NodeJS.Timeout
  // Once true the runtime has been retired and must never spawn another
  // ffmpeg child. Set when the entry is reconfigured or cleared so that
  // any in-flight exit handler / restart timer from the previous
  // generation is a no-op even though it still holds a closure reference
  // to this object.
  released: boolean
}

interface IngressRuntime {
  publishing: boolean
  receivingPackets: boolean
  bytesReceived: number
  bytesPerSecond: number
  bytesAtLastTick: number
  session?: NmsSession
  // Number of consecutive pollSampler ticks during which we were
  // publishing=true but observed 0 bytes/sec. Reset on bytes flowing,
  // on a new publisher session connecting, or on any cleanup path.
  // When this reaches STALE_INGRESS_TICKS the splitter assumes node-
  // media-server has held onto a dead TCP connection (no FIN/RST ever
  // arrived, so onClose -> donePublish never fired) and force-clears
  // the ingress.
  zeroByteTicks: number
}

interface SplitEntry {
  eventId: string
  destinations: string[]
  ingress: IngressRuntime
  outbounds: OutboundRuntime[]
  statusListeners: Set<WebSocket>
}

const APP_NAME = 'split'
const SAMPLE_INTERVAL_MS = 1000
const BACKOFF_STEPS_MS = [1000, 2000, 5000, 10000]
// How long to wait between SIGTERM and SIGKILL when shutting an
// outbound ffmpeg child down. Kept low because once we decide a child
// must die we want the destination's stream key freed quickly so the
// next spawn can claim it (e.g. AWS IVS only allows one publisher per
// key).
const SIGKILL_GRACE_MS = 3000
// How many consecutive 1-second pollSampler ticks of "publishing=true
// but 0 bytes/sec" before we conclude the publisher session is a
// zombie (the TCP peer died silently and NMS never fired donePublish)
// and force-clear it. 30s is generous enough to ride out an OBS
// keyframe-interval wait or a brief encoder hiccup but tight enough
// that operators don't have to PM2-restart the process to recover.
const STALE_INGRESS_TICKS = 30

const splits = new Map<string, SplitEntry>()
let initialized = false
let pollTimer: NodeJS.Timeout | undefined

/**
 * Sanitize an eventId so it is safe to interpolate into ffmpeg argv. Only
 * letters, digits, dashes and underscores are permitted.
 */
function sanitizeEventId(eventId: string): string | null {
  if (typeof eventId !== 'string' || eventId.length === 0) return null
  if (!/^[a-zA-Z0-9_-]+$/.test(eventId)) return null
  return eventId
}

function createIngressRuntime(): IngressRuntime {
  return {
    publishing: false,
    receivingPackets: false,
    bytesReceived: 0,
    bytesPerSecond: 0,
    bytesAtLastTick: 0,
    zeroByteTicks: 0
  }
}

function createOutboundRuntime(url: string): OutboundRuntime {
  return {
    url,
    state: 'idle',
    bytesSent: 0,
    bytesPerSecond: 0,
    bytesAtLastTick: 0,
    restartCount: 0,
    spawned: new Set<ChildProcess>(),
    released: false
  }
}

/**
 * Check whether a PID corresponds to a live OS process. Returns false on
 * any error -- including ESRCH (no such process) AND less-expected errors
 * like EINVAL -- so a misbehaving environment can never cause us to
 * SIGKILL an unrelated PID.
 */
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
 * Send `signal` to `pid` via the raw process.kill syscall (NOT via the
 * ChildProcess wrapper). Necessary at SIGKILL-escalation time because
 * Node's ChildProcess sets an internal `killed` flag after the first
 * kill() call and may refuse subsequent ones even if the OS process is
 * actually still alive.
 */
function killByPid(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid == null || pid <= 0) return
  try {
    process.kill(pid, signal)
  } catch {
    /* ignore -- pid may already be gone, which is fine */
  }
}

function toIngressSnapshot(r: IngressRuntime): SplitIngressStatus {
  return {
    publishing: r.publishing,
    receivingPackets: r.receivingPackets,
    bytesReceived: r.bytesReceived,
    bytesPerSecond: r.bytesPerSecond
  }
}

function toOutboundSnapshot(o: OutboundRuntime): SplitOutboundStatus {
  return {
    url: o.url,
    state: o.state,
    lastError: o.lastError,
    bytesSent: o.bytesSent,
    bytesPerSecond: o.bytesPerSecond,
    restartCount: o.restartCount
  }
}

function toStatusSnapshot(entry: SplitEntry): SplitStatus {
  return {
    eventId: entry.eventId,
    destinations: [...entry.destinations],
    ingress: toIngressSnapshot(entry.ingress),
    outbounds: entry.outbounds.map(toOutboundSnapshot)
  }
}

function broadcastStatus(entry: SplitEntry): void {
  if (entry.statusListeners.size === 0) return
  const message: SplitStatusMessage = {
    type: 'splitStatus',
    data: toStatusSnapshot(entry)
  }
  const messageStr = JSON.stringify(message)
  for (const ws of Array.from(entry.statusListeners)) {
    if (ws.readyState === 1) {
      try {
        ws.send(messageStr)
      } catch (error) {
        logger('Error broadcasting split status:', error)
        entry.statusListeners.delete(ws)
      }
    }
  }
}

function getOrCreate(eventId: string): SplitEntry {
  let entry = splits.get(eventId)
  if (entry != null) return entry
  entry = {
    eventId,
    destinations: [],
    ingress: createIngressRuntime(),
    outbounds: [],
    statusListeners: new Set<WebSocket>()
  }
  splits.set(eventId, entry)
  return entry
}

/**
 * Public API ---------------------------------------------------------------
 */

export interface SetSplitResult {
  ok: boolean
  status?: SplitStatus
  error?: string
}

export function setSplit(
  eventId: string,
  destinations: string[]
): SetSplitResult {
  if (sanitizeEventId(eventId) == null) {
    return { ok: false, error: 'Invalid eventId' }
  }
  if (
    !Array.isArray(destinations) ||
    destinations.length < 1 ||
    destinations.length > 4
  ) {
    return {
      ok: false,
      error: 'destinations must be an array of 1 to 4 URLs'
    }
  }
  for (const url of destinations) {
    if (typeof url !== 'string' || url.length === 0) {
      return { ok: false, error: 'destination URL must be a non-empty string' }
    }
    if (!/^rtmps?:\/\//.test(url)) {
      return {
        ok: false,
        error: `destination URL must start with rtmp:// or rtmps:// (got "${url}")`
      }
    }
  }
  const entry = getOrCreate(eventId)
  // Always retire the previous outbounds before swapping in new runtime
  // objects. If we only stopped them when wasPublishing was true, any
  // outbounds whose restart timer or in-flight exit handler fired between
  // the publisher dropping and this reconfigure call would resurrect
  // themselves against the now-stale URL forever.
  releaseOutbounds(entry, 'reconfigure')
  entry.destinations = [...destinations]
  entry.outbounds = destinations.map(createOutboundRuntime)
  if (entry.ingress.publishing) {
    startOutbounds(entry)
  }
  broadcastStatus(entry)
  return { ok: true, status: toStatusSnapshot(entry) }
}

/**
 * Deactivate forwarding for an event WITHOUT discarding the configured
 * destinations.
 *
 * - Kills any running ffmpeg children and marks each outbound runtime
 *   as released (so the closure-captured exit handlers / restart timers
 *   become no-ops).
 * - Force-closes the ingress publisher (if any). Stop is the operator's
 *   way of saying "fully reset this event," so we kick the publisher
 *   too -- otherwise an alive publisher would keep filling NMS's
 *   buffers (and our `bytesReceived` counter) for an event that has no
 *   destinations to forward to, AND a *zombie* publisher (TCP peer died
 *   silently) would never be cleared because Stop only used to release
 *   outbounds. The operator can resume by clicking Save / Activate,
 *   which prompts the encoder to reconnect against fresh state.
 * - Sets each outbound's state to 'stopped' so the UI can display
 *   "Destination N: Stopped" instead of suddenly hiding the row.
 * - LEAVES `entry.destinations` and `entry.outbounds` populated so the
 *   client UI can keep showing the same destination URLs in the input
 *   fields and operators can resume forwarding by clicking Save again.
 *
 * If the publisher reconnects after a stop, the released outbound
 * runtimes refuse to spawn (the `released` short-circuit in
 * spawnOutbound), so reactivation requires a deliberate setSplit() call
 * which installs fresh runtime objects.
 */
export function stopSplit(eventId: string): boolean {
  const entry = splits.get(eventId)
  if (entry == null) return false
  // forceCloseIngress only handles ingress; outbound teardown is
  // releaseOutbounds's job. Order doesn't matter for correctness here
  // (the two operate on disjoint parts of the entry) but we do
  // ingress first so the eventual NMS donePublish event handler -- if
  // it fires from session.close() / socket.destroy() -- can be a
  // total no-op (its `if (entry.ingress.session !== session)` guard
  // already passes by the time NMS gets around to it).
  if (entry.ingress.publishing || entry.ingress.session != null) {
    forceCloseIngress(entry, 'stopped')
  }
  releaseOutbounds(entry, 'stopped')
  broadcastStatus(entry)
  return true
}

/**
 * Fully remove an event's split configuration. Used by tests and
 * potential admin tooling; not exposed via the regular UI Stop button.
 */
export function clearSplit(eventId: string): boolean {
  const entry = splits.get(eventId)
  if (entry == null) return false
  if (entry.ingress.publishing || entry.ingress.session != null) {
    forceCloseIngress(entry, 'cleared')
  }
  releaseOutbounds(entry, 'cleared')
  entry.destinations = []
  entry.outbounds = []
  broadcastStatus(entry)
  return true
}

export function getStatusSnapshot(eventId: string): SplitStatus | null {
  const entry = splits.get(eventId)
  if (entry == null) return null
  return toStatusSnapshot(entry)
}

export function subscribeStatus(eventId: string, ws: WebSocket): SplitStatus {
  const entry = getOrCreate(eventId)
  entry.statusListeners.add(ws)
  return toStatusSnapshot(entry)
}

export function unsubscribeStatus(eventId: string, ws: WebSocket): void {
  const entry = splits.get(eventId)
  if (entry == null) return
  entry.statusListeners.delete(ws)
}

/**
 * Test-only: drive a single pollSampler tick on demand. Unit tests
 * don't run `initializeRtmpSplitter` (which is what installs the 1Hz
 * interval timer), so without this export there is no way to exercise
 * the stale-publisher detector in deterministic time. Calling N times
 * is equivalent to N seconds of wall-clock time as far as the sampler
 * is concerned.
 */
export function tickSamplerForTest(): void {
  pollSampler()
}

/**
 * Test-only: install a fake NMS session on the ingress runtime. Used
 * by tests that need to verify forceCloseIngress's three-step cleanup
 * cascade (close -> destroy -> broadcast.donePublish) actually fires
 * each step. forcePublishForTest alone leaves session=undefined.
 */
export function attachIngressSessionForTest(
  eventId: string,
  session: {
    id: string
    inBytes?: number
    close?: () => void
    socket?: { destroy?: () => void }
    broadcast?: { donePublish?: (session: unknown) => void }
  }
): void {
  const entry = splits.get(eventId)
  if (entry == null) return
  entry.ingress.session = session as NmsSession
}

/**
 * Test-only: flip the ingress publishing flag for an event. Lets unit
 * tests exercise outbound spawn / restart logic without standing up
 * node-media-server. Mirrors the side-effects of postPublish/donePublish
 * (calls startOutbounds when going true, stopOutbounds when going false)
 * but skips the actual NMS session bookkeeping.
 */
export function forcePublishForTest(
  eventId: string,
  publishing: boolean
): void {
  const entry = splits.get(eventId)
  if (entry == null) return
  if (publishing && !entry.ingress.publishing) {
    entry.ingress.publishing = true
    entry.ingress.bytesAtLastTick = 0
    entry.ingress.bytesReceived = 0
    entry.ingress.receivingPackets = false
    entry.ingress.bytesPerSecond = 0
    entry.ingress.zeroByteTicks = 0
    startOutbounds(entry)
  } else if (!publishing && entry.ingress.publishing) {
    entry.ingress.publishing = false
    entry.ingress.receivingPackets = false
    entry.ingress.bytesPerSecond = 0
    entry.ingress.zeroByteTicks = 0
    stopOutbounds(entry, 'test publisher disconnected')
  }
}

/**
 * Resolve the publicly-reachable base URL of the RTMP splitter
 * (scheme + host + port, NO trailing slash, NO path).
 *
 * Prefers the explicit `splitterUrl` in serverConfig. If that is empty,
 * falls back to a `rtmp://{listenHost}:{rtmpPort}` URL constructed from
 * the local bind config -- only useful for single-host development; in
 * production `splitterUrl` MUST be configured because the server has no
 * reliable way to know what public DNS name end users reach it by.
 */
function getSplitterBaseUrl(): string {
  if (serverConfig.splitterUrl !== '') {
    return serverConfig.splitterUrl.replace(/\/+$/, '')
  }
  return `rtmp://${serverConfig.listenHost}:${serverConfig.rtmpPort}`
}

export function getIngressUrl(eventId: string): string {
  return `${getSplitterBaseUrl()}/${APP_NAME}/${eventId}`
}

export function getSplitConfig(): {
  splitterUrl: string
  app: string
} {
  return {
    splitterUrl: getSplitterBaseUrl(),
    app: APP_NAME
  }
}

/**
 * Outbound process management ---------------------------------------------
 */

function buildFfmpegArgs(eventId: string, destination: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'info',
    '-i',
    `rtmp://127.0.0.1:${serverConfig.rtmpPort}/${APP_NAME}/${eventId}`,
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
    destination
  ]
}

const CONNECTED_LINE_RE = /Output\s+#0,\s*flv,\s*to\s+'/
const PROGRESS_LINE_RE = /\bframe=\s*\d+/
const ERROR_LINE_RE =
  /(Connection refused|Connection timed out|No route to host|I\/O error|Server returned|Failed to update header|RTMP_Connect|TLS_send|Unknown error|HTTP error)/i
function parseSize(token: string, unit: string): number {
  const n = parseInt(token, 10)
  if (!Number.isFinite(n)) return 0
  switch (unit) {
    case 'kB':
    case 'kb':
    case 'KB':
      return n * 1024
    case 'MB':
    case 'Mb':
      return n * 1024 * 1024
    case 'GB':
    case 'Gb':
      return n * 1024 * 1024 * 1024
    default:
      return n
  }
}

function spawnOutbound(entry: SplitEntry, outbound: OutboundRuntime): void {
  if (outbound.restartTimer != null) {
    clearTimeout(outbound.restartTimer)
    outbound.restartTimer = undefined
  }
  // A spawn after a stop means the operator decided to forward again
  // (e.g. publisher reconnected after a 'publisher disconnected' stop).
  // Cancel any pending SIGKILL escalation so we don't accidentally
  // SIGKILL the brand-new child we are about to register.
  if (outbound.killEscalationTimer != null) {
    clearTimeout(outbound.killEscalationTimer)
    outbound.killEscalationTimer = undefined
  }
  // The runtime was retired between the restart timer being scheduled and
  // it firing (e.g. user reconfigured destinations or cleared the entry).
  // Do not spawn another ffmpeg child against a stale URL.
  if (outbound.released) return
  const args = buildFfmpegArgs(entry.eventId, outbound.url)
  logger(
    `[split:${entry.eventId}] spawning ffmpeg for ${outbound.url}: ffmpeg ${args.join(' ')}`
  )
  let child: ChildProcess
  try {
    child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    outbound.state = 'error'
    outbound.lastError = `failed to spawn ffmpeg: ${String(error)}`
    broadcastStatus(entry)
    return
  }
  outbound.child = child
  outbound.spawned.add(child)
  outbound.state = 'connecting'
  outbound.lastError = undefined
  broadcastStatus(entry)

  let buffer = ''
  const onLine = (line: string): void => {
    if (line.length === 0) return
    if (
      outbound.state !== 'connected' &&
      (CONNECTED_LINE_RE.test(line) || PROGRESS_LINE_RE.test(line))
    ) {
      outbound.state = 'connected'
      outbound.lastError = undefined
      broadcastStatus(entry)
    }
    // Scan ALL size= matches in the line, not just the first. ffmpeg writes
    // its progress in a single long stream where many updates share one
    // line, so we want the latest cumulative size, not the oldest.
    let lastSize: number | undefined
    const sizeRe = /size=\s*(\d+)([kKMG]?B)/g
    let m: RegExpExecArray | null
    while ((m = sizeRe.exec(line)) != null) {
      lastSize = parseSize(m[1], m[2])
    }
    if (lastSize != null) outbound.bytesSent = lastSize
    if (ERROR_LINE_RE.test(line)) {
      outbound.state = 'error'
      outbound.lastError = line.trim().slice(0, 256)
      broadcastStatus(entry)
    }
  }
  // ffmpeg's periodic progress output uses \r (carriage return), not \n,
  // to overwrite the same status line in-place. Split on EITHER \r or \n so
  // each progress update is parsed as soon as it arrives instead of waiting
  // for the full process output to be flushed at exit time.
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8')
    let idx = buffer.search(/[\r\n]/)
    while (idx !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      onLine(line)
      idx = buffer.search(/[\r\n]/)
    }
  }
  child.stderr?.on('data', onData)
  child.stdout?.on('data', onData)

  let exitHandled = false
  child.on('exit', (code, signal) => {
    // De-dup: Node has been observed in production to emit 'exit' more
    // than once per ChildProcess. Treat the first emission as canonical
    // and ignore the rest so we never double-increment restartCount or
    // double-schedule a restart.
    if (exitHandled) {
      logger(
        `[split:${entry.eventId}] duplicate exit for ffmpeg pid=${child.pid} url=${outbound.url}; ignoring`
      )
      return
    }
    exitHandled = true
    const pid = child.pid
    logger(
      `[split:${entry.eventId}] ffmpeg for ${outbound.url} exited code=${code} signal=${signal} pid=${pid}`
    )
    // Phantom exit detection. If Node says the child died but the OS
    // still has the PID alive, force-kill it and DO NOT process this as
    // a real exit. We keep the child in `outbound.spawned` so the next
    // pollSampler tick (or an explicit stopOutbound) can finish the job.
    if (isPidAlive(pid)) {
      logger(
        `[split:${entry.eventId}] phantom exit: ffmpeg pid=${pid} still alive; sending SIGKILL`
      )
      killByPid(pid, 'SIGKILL')
      broadcastStatus(entry)
      return
    }
    outbound.spawned.delete(child)
    // An earlier spawn's 'exit' arrived after we'd already moved on to a
    // newer child. Drop tracking for the stale child but don't touch
    // the state machine -- the current child is responsible for that.
    if (outbound.child !== child) {
      broadcastStatus(entry)
      return
    }
    outbound.child = undefined
    // If the runtime was retired (reconfigure / clear) it must never
    // restart, regardless of state, error, or current publish status.
    if (outbound.released) {
      broadcastStatus(entry)
      return
    }
    // If the splitter intentionally stopped this child (state was set to
    // 'stopped' before SIGTERM) we don't restart.
    if (outbound.state === 'stopped') {
      broadcastStatus(entry)
      return
    }
    if (!entry.ingress.publishing) {
      outbound.state = 'stopped'
      broadcastStatus(entry)
      return
    }
    if (
      code !== 0 &&
      (outbound.lastError == null || outbound.lastError === '')
    ) {
      outbound.lastError = `ffmpeg exited with code ${code}`
    }
    const backoff =
      BACKOFF_STEPS_MS[
        Math.min(outbound.restartCount, BACKOFF_STEPS_MS.length - 1)
      ]
    outbound.restartCount += 1
    outbound.state = 'connecting'
    broadcastStatus(entry)
    if (outbound.restartTimer != null) {
      clearTimeout(outbound.restartTimer)
    }
    outbound.restartTimer = setTimeout(() => {
      spawnOutbound(entry, outbound)
    }, backoff)
  })
  child.on('error', error => {
    logger(`[split:${entry.eventId}] ffmpeg spawn error: ${String(error)}`)
    outbound.state = 'error'
    outbound.lastError = `spawn error: ${String(error)}`
    broadcastStatus(entry)
  })
}

function startOutbounds(entry: SplitEntry): void {
  for (const outbound of entry.outbounds) {
    spawnOutbound(entry, outbound)
  }
}

function stopOutbounds(entry: SplitEntry, reason: string): void {
  for (const outbound of entry.outbounds) {
    stopOutbound(outbound)
  }
  logger(`[split:${entry.eventId}] outbounds stopped (${reason})`)
}

function stopOutbound(outbound: OutboundRuntime): void {
  if (outbound.restartTimer != null) {
    clearTimeout(outbound.restartTimer)
    outbound.restartTimer = undefined
  }
  outbound.state = 'stopped'
  outbound.bytesPerSecond = 0
  // SIGTERM every tracked child. In the common case `outbound.spawned`
  // contains just the current `child`, but if a previous spawn had a
  // phantom 'exit' event there will be additional survivors in here
  // which the old code couldn't reach.
  for (const c of outbound.spawned) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  // Snapshot the set NOW. If a publisher reconnects between SIGTERM and
  // SIGKILL grace (e.g. when stopOutbound is called from donePublish),
  // a new ChildProcess could end up in outbound.spawned by the time the
  // escalation timer fires; we don't want to kill it.
  const toEscalate = Array.from(outbound.spawned)
  if (outbound.killEscalationTimer != null) {
    clearTimeout(outbound.killEscalationTimer)
  }
  outbound.killEscalationTimer = setTimeout(() => {
    outbound.killEscalationTimer = undefined
    for (const c of toEscalate) {
      const pid = c.pid
      if (isPidAlive(pid)) {
        logger(
          `[split] SIGKILL escalation for ffmpeg pid=${pid} url=${outbound.url}: did not respond to SIGTERM within ${SIGKILL_GRACE_MS}ms`
        )
        killByPid(pid, 'SIGKILL')
      }
    }
  }, SIGKILL_GRACE_MS)
  outbound.killEscalationTimer.unref?.()
}

/**
 * Forcibly clear an entry's ingress publisher state, without waiting
 * for node-media-server to notice the publisher is gone.
 *
 * Use cases:
 *   1. Stale-publisher detection from pollSampler -- the TCP peer died
 *      silently (no FIN/RST), so NMS still believes the streamPath has
 *      an active publisher and rejects every reconnect attempt with
 *      "already has a publisher". The operator-visible symptom is a
 *      yellow "Connected, no packets" indicator that never recovers.
 *   2. stopSplit / clearSplit -- the operator explicitly asked to stop;
 *      we don't want a still-alive publisher to keep filling NMS's
 *      buffers (and our `bytesReceived` counter) for an event that has
 *      no destinations to forward to.
 *
 * The cleanup happens in three layered attempts so we recover even
 * when the underlying socket is in an unusual state:
 *
 *   a. session.close() -- graceful socket.end(). Works in the common
 *      case where the publisher socket is alive.
 *   b. session.socket.destroy() -- forceful socket teardown. Catches
 *      cases where end() is a no-op because the socket is already
 *      half-closed.
 *   c. session.broadcast.donePublish(session) -- direct call into NMS
 *      to release its "this streamPath has a publisher" lock, in case
 *      neither of the above triggers RtmpSession.onClose. donePublish
 *      is idempotent (checks session === this.publisher).
 *
 * Crucially, our local `entry.ingress` is reset BEFORE invoking any of
 * those, so:
 *   - If our donePublish event handler fires from one of (a)/(b)/(c),
 *     it short-circuits via `if (entry.ingress.session !== session)`.
 *   - If none of them work, the splitter UI still recovers because we
 *     no longer reference the dead session and the next pollSampler
 *     tick won't read its frozen inBytes.
 *
 * NOTE: this function does NOT touch outbounds. Each caller decides
 * whether to `stopOutbounds` (let them respawn on next publisher) or
 * `releaseOutbounds` (refuse to respawn until setSplit is called). The
 * stale-publisher path wants the former; stopSplit/clearSplit want the
 * latter. Centralizing outbound cleanup here would either double-kill
 * children (if the caller also called release/stop) or silently change
 * the release semantics depending on how forceCloseIngress was called.
 */
function forceCloseIngress(entry: SplitEntry, reason: string): void {
  const session = entry.ingress.session
  entry.ingress.publishing = false
  entry.ingress.receivingPackets = false
  entry.ingress.bytesPerSecond = 0
  entry.ingress.zeroByteTicks = 0
  entry.ingress.session = undefined
  if (session != null) {
    logger(
      `[split:${entry.eventId}] forcing publisher session ${session.id} closed (${reason})`
    )
    try {
      session.close?.()
    } catch (error) {
      logger(
        `[split:${entry.eventId}] session.close() threw during force-close: ${String(error)}`
      )
    }
    try {
      session.socket?.destroy?.()
    } catch (error) {
      logger(
        `[split:${entry.eventId}] socket.destroy() threw during force-close: ${String(error)}`
      )
    }
    try {
      session.broadcast?.donePublish?.(session)
    } catch (error) {
      logger(
        `[split:${entry.eventId}] broadcast.donePublish() threw during force-close: ${String(error)}`
      )
    }
  }
}

/**
 * Permanently retire the current outbound runtimes for an entry. After
 * this returns the OutboundRuntime objects are guaranteed never to spawn
 * another ffmpeg child even if their previously-scheduled restart timer
 * or in-flight exit handler fires. Use this whenever entry.outbounds is
 * about to be replaced (setSplit) or removed (clearSplit) so old
 * runtimes don't keep retrying against stale destination URLs.
 */
function releaseOutbounds(entry: SplitEntry, reason: string): void {
  for (const outbound of entry.outbounds) {
    outbound.released = true
    stopOutbound(outbound)
  }
  if (entry.outbounds.length > 0) {
    logger(`[split:${entry.eventId}] outbounds released (${reason})`)
  }
}

/**
 * Periodic byte-rate sampler. Runs once per second across all splits and
 * updates ingress/outbound `bytesPerSecond` plus the receivingPackets bool.
 * Only broadcasts when something interesting changes (receivingPackets flip
 * or non-zero throughput tick) to keep WS chatter low.
 */
function pollSampler(): void {
  for (const entry of splits.values()) {
    const ingress = entry.ingress
    let dirty = false
    const currentInBytes = ingress.session?.inBytes ?? 0
    if (ingress.publishing === true) {
      const delta = currentInBytes - ingress.bytesAtLastTick
      ingress.bytesPerSecond = delta > 0 ? delta : 0
      ingress.bytesAtLastTick = currentInBytes
      ingress.bytesReceived = currentInBytes
      const nextReceiving = ingress.bytesPerSecond > 0
      if (nextReceiving !== ingress.receivingPackets) {
        ingress.receivingPackets = nextReceiving
        dirty = true
      }
      if (ingress.bytesPerSecond > 0) {
        dirty = true
        ingress.zeroByteTicks = 0
      } else {
        ingress.zeroByteTicks += 1
        if (ingress.zeroByteTicks >= STALE_INGRESS_TICKS) {
          logger(
            `[split:${entry.eventId}] stale publisher detected: 0 bytes for ${ingress.zeroByteTicks}s; force-closing`
          )
          // Stop, but do NOT release: when a fresh publisher reconnects
          // (e.g. OBS auto-reconnect after we kicked the zombie) the
          // existing destination configuration should kick back in
          // automatically, the same way it would if the publisher had
          // never gone stale.
          forceCloseIngress(entry, 'stale publisher (no bytes)')
          stopOutbounds(entry, 'stale publisher (no bytes)')
          broadcastStatus(entry)
          continue
        }
      }
    } else if (
      ingress.bytesPerSecond !== 0 ||
      ingress.receivingPackets === true ||
      ingress.zeroByteTicks !== 0
    ) {
      ingress.bytesPerSecond = 0
      ingress.receivingPackets = false
      ingress.zeroByteTicks = 0
      dirty = true
    }
    for (const outbound of entry.outbounds) {
      // Sweep `outbound.spawned` of any ChildProcess whose OS PID is no
      // longer alive. This is the canonical cleanup path for entries
      // that landed in the set via a phantom 'exit' event (where the
      // process was still alive at exit-emit time and we kept tracking
      // it).
      if (outbound.spawned.size > 0) {
        for (const c of outbound.spawned) {
          if (!isPidAlive(c.pid)) outbound.spawned.delete(c)
        }
      }
      const delta = outbound.bytesSent - outbound.bytesAtLastTick
      const bps = delta > 0 ? delta : 0
      outbound.bytesAtLastTick = outbound.bytesSent
      if (bps !== outbound.bytesPerSecond) {
        outbound.bytesPerSecond = bps
        if (bps > 0) dirty = true
      }
    }
    if (dirty) broadcastStatus(entry)
  }
}

/**
 * Bootstrap ----------------------------------------------------------------
 */

let nmsInstance: NmsInstance | undefined

export function initializeRtmpSplitter(): void {
  if (initialized) return
  initialized = true

  let NodeMediaServer: NmsCtor
  try {
    NodeMediaServer = require('node-media-server') as NmsCtor
  } catch (error) {
    logger('RTMP splitter disabled: node-media-server failed to load:', error)
    return
  }

  const config = {
    bind: serverConfig.rtmpHost,
    rtmp: {
      port: serverConfig.rtmpPort
    }
  }
  try {
    nmsInstance = new NodeMediaServer(config)
  } catch (error) {
    logger('RTMP splitter: failed to construct NodeMediaServer:', error)
    return
  }

  nmsInstance.on('postPublish', (session: NmsSession) => {
    // Note: NMS v4 sets session.isPublisher = true AFTER this event fires,
    // so we cannot guard on it here. The event itself implies a publish flow.
    if (session.streamApp !== APP_NAME) return
    const eventId = sanitizeEventId(session.streamName ?? '')
    if (eventId == null) {
      logger(`[split] rejecting invalid streamName "${session.streamName}"`)
      return
    }
    const entry = splits.get(eventId)
    if (entry == null || entry.destinations.length === 0) {
      logger(
        `[split:${eventId}] publisher connected but no destinations configured; ignoring`
      )
      return
    }
    // NMS v4 fires `postPublish` BEFORE its "streamPath already has a
    // publisher" guard runs, so a duplicate publisher attempt (e.g. the
    // encoder reconnecting before the old session has been torn down)
    // triggers this handler even though NMS will immediately reject the
    // new session. If we already have an active ingress session, ignore
    // the new one -- otherwise we would (a) overwrite our reference to
    // the still-active publisher, losing track of it for donePublish,
    // and (b) re-spawn outbound ffmpegs that fight the existing ones
    // for the destination stream key, producing the dozen-retries
    // failure mode the splitter previously got stuck in.
    if (entry.ingress.session != null && entry.ingress.publishing) {
      logger(
        `[split:${eventId}] duplicate publisher attempt (session ${session.id}) ignored; already publishing as session ${entry.ingress.session.id}`
      )
      return
    }
    logger(`[split:${eventId}] publisher connected (session ${session.id})`)
    entry.ingress.session = session
    entry.ingress.publishing = true
    entry.ingress.bytesAtLastTick = session.inBytes ?? 0
    entry.ingress.bytesReceived = session.inBytes ?? 0
    entry.ingress.receivingPackets = false
    entry.ingress.bytesPerSecond = 0
    entry.ingress.zeroByteTicks = 0
    broadcastStatus(entry)
    startOutbounds(entry)
  })

  nmsInstance.on('donePublish', (session: NmsSession) => {
    if (session.streamApp !== APP_NAME) return
    const eventId = sanitizeEventId(session.streamName ?? '')
    if (eventId == null) return
    const entry = splits.get(eventId)
    if (entry == null) return
    if (entry.ingress.session !== session) return
    logger(`[split:${eventId}] publisher disconnected`)
    entry.ingress.publishing = false
    entry.ingress.receivingPackets = false
    entry.ingress.bytesPerSecond = 0
    entry.ingress.zeroByteTicks = 0
    entry.ingress.session = undefined
    stopOutbounds(entry, 'publisher disconnected')
    broadcastStatus(entry)
  })

  try {
    nmsInstance.run()
  } catch (error) {
    logger('RTMP splitter: failed to start NodeMediaServer:', error)
    return
  }

  pollTimer = setInterval(pollSampler, SAMPLE_INTERVAL_MS)
  pollTimer.unref?.()

  const shutdown = (): void => {
    if (pollTimer != null) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
    for (const entry of splits.values()) {
      stopOutbounds(entry, 'shutdown')
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  logger(
    `RTMP splitter listening on rtmp://${serverConfig.rtmpHost}:${serverConfig.rtmpPort}/${APP_NAME}/{eventId}`
  )
}
