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
  child?: ChildProcess
  restartTimer?: NodeJS.Timeout
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
    bytesAtLastTick: 0
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
    released: false
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
    destinations.length > 2
  ) {
    return {
      ok: false,
      error: 'destinations must be an array of 1 or 2 URLs'
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
    startOutbounds(entry)
  } else if (!publishing && entry.ingress.publishing) {
    entry.ingress.publishing = false
    entry.ingress.receivingPackets = false
    entry.ingress.bytesPerSecond = 0
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

  child.on('exit', (code, signal) => {
    logger(
      `[split:${entry.eventId}] ffmpeg for ${outbound.url} exited code=${code} signal=${signal}`
    )
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
  if (outbound.child != null) {
    try {
      outbound.child.kill('SIGTERM')
    } catch {}
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
      if (ingress.bytesPerSecond > 0) dirty = true
    } else if (
      ingress.bytesPerSecond !== 0 ||
      ingress.receivingPackets === true
    ) {
      ingress.bytesPerSecond = 0
      ingress.receivingPackets = false
      dirty = true
    }
    for (const outbound of entry.outbounds) {
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
    logger(`[split:${eventId}] publisher connected (session ${session.id})`)
    entry.ingress.session = session
    entry.ingress.publishing = true
    entry.ingress.bytesAtLastTick = session.inBytes ?? 0
    entry.ingress.bytesReceived = session.inBytes ?? 0
    entry.ingress.receivingPackets = false
    entry.ingress.bytesPerSecond = 0
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
