import {
  type EventName,
  type Level,
  PLAYBACK_ERROR_DETAILS,
  type PlaybackEngine,
  type PlaybackErrorKind,
  type PlaybackSurface,
  type Property,
  type RecoveryKind,
  type SeekKind
} from '../../common/observability/contract'
import { RateLimit } from '../../common/observability/rateLimit'
import { emitAppLog } from '../observability/log'
import { randomUuid } from '../stream/deviceId'
import type { PlayIntent } from './playIntent'
import { seekableEndOf, type VideoHandle } from './videoHandle'

/**
 * One player attachment's telemetry, from the moment a playlist is handed to
 * a player until it is taken away: how long it took to show a picture, every
 * stall, seek, error and recovery, and a heartbeat while it plays. Each event
 * carries the attachment's own session id (`ps`) so a viewer's whole story
 * can be read back in order, and none carries an address or a token.
 *
 * It holds no timer of its own: the heartbeat rides on the player's time
 * updates, and a first frame that has not come is noticed on the player's
 * next event, or at the latest when the attachment ends. A player that says
 * nothing at all says so in its closing tally (`playback_detached`).
 *
 * Logging never changes playback: every emit is caught, and a session that
 * has said too much in a minute, or in all, goes quiet rather than flooding
 * the queue the rest of the app's events share.
 */

/** How often a playing player says where it is. */
export const HEARTBEAT_MS = 30_000
/** How long a player asked to play may take before it is reported as not having. */
export const FIRST_FRAME_WAIT_MS = 30_000
/** The most events one attachment sends, all told. */
export const SESSION_EVENT_CAP = 600
/** The most events one attachment sends in a minute. */
export const PER_MINUTE_CAP = 60
/**
 * Routine events (heartbeats, bitrate changes, non-fatal errors) have their
 * own, smaller budget, so a long session or a bad line can never spend the
 * one its stalls, recoveries and fatal errors are sent from.
 */
export const ROUTINE_SESSION_CAP = 300
export const ROUTINE_PER_MINUTE_CAP = 20
/**
 * Seeks have a budget of their own too: a grid scrub seeks every tile up to
 * four times a second, and the stall that follows a seek into unloaded
 * footage must still be sent.
 */
export const SEEK_SESSION_CAP = 200
export const SEEK_PER_MINUTE_CAP = 20
/** Recoveries that load the source again, each one a reload in `rl`. */
const RELOADING: ReadonlySet<RecoveryKind> = new Set<RecoveryKind>([
  'reload',
  'stall_reload',
  'playlist_watch_reload'
])
/** How long a seek's stated reason waits for the player's own `seeking`. */
export const SEEK_MARK_MS = 2000
/** A position change smaller than this between two time updates is a still picture. */
const MOVED_SEC = 0.01
/** The contract's bound on every duration property (`ms`, `wms`, `sms`). */
const MAX_MS = 86400000
/**
 * A seek still unanswered after this long was dropped by the player (a
 * reattach, a reload, a reset): it is forgotten rather than left to swallow
 * the session's later seeks and freeze its position.
 */
export const SEEK_STALE_MS = 10000
/** The longest time update gap counted as watching: a longer one was a hiccup. */
const TICK_CAP_MS = 2000
/** A new bitrate is reported when it moves by more than this share. */
const BITRATE_CHANGE = 0.1

export type PlaybackStart = 'live_edge' | 'position' | 'start'

export interface PlaybackDescription {
  videoId?: string
  engine: PlaybackEngine
  surface: PlaybackSurface
  live: boolean
  start: PlaybackStart
}

export type PlaybackEmit = (
  event: EventName,
  properties: Record<string, Property>,
  level?: Level
) => void

/** Milliseconds now; replaceable in a test. */
export type PlaybackClock = () => number

const sessions = new WeakMap<object, PlaybackSession>()
const marks = new WeakMap<object, { kind: SeekKind; at: number }>()

/** The session watching a player, if one is. */
export function playbackOf(handle: object): PlaybackSession | undefined {
  return sessions.get(handle)
}

/**
 * Says why the next seek of this player happens, just before the code that
 * moves it does. `replace: false` keeps a reason already given, so a caller
 * that knows more (a jump to live) is not overwritten by the generic seek it
 * goes through.
 */
export function markSeek(
  handle: object,
  kind: SeekKind,
  replace = true,
  now: number = Date.now()
): void {
  const held = marks.get(handle)
  if (!replace && held != null && now - held.at <= SEEK_MARK_MS) return
  marks.set(handle, { kind, at: now })
}

function takeMark(handle: object, now: number): SeekKind {
  const held = marks.get(handle)
  marks.delete(handle)
  return held != null && now - held.at <= SEEK_MARK_MS ? held.kind : 'other'
}

/**
 * The video id in a playback address, never the address: `/videos/<id>/`,
 * the secret path `/videos/<id>-<secret>/`, or a PeerTube-stored video's
 * `/peertube/<id>/` or `/peertube/private/<id>/`.
 */
export function videoIdOf(url: string): string | undefined {
  const match =
    /\/(?:videos|peertube(?:\/private)?)\/(vid_[A-Za-z0-9_-]+?)(?:-[0-9a-f]{32})?(?:\/|$)/.exec(
      url
    )
  const id = match?.[1]
  return id != null && /^vid_[A-Za-z0-9_-]{1,96}$/.test(id) ? id : undefined
}

const surfaces = new WeakMap<object, PlaybackSurface>()

/**
 * Names where a player shows, for an owner that attaches without an intent
 * (a finished video's card): read when the next attachment starts.
 */
export function nameSurface(handle: object, surface: PlaybackSurface): void {
  surfaces.set(handle, surface)
}

/** Where a player shows, from what its caller said about it. */
export function surfaceOf(
  intent: Pick<PlayIntent, 'buffer' | 'preview' | 'surface'> | undefined,
  handle?: object
): PlaybackSurface {
  if (intent?.surface != null) return intent.surface
  const named = handle == null ? undefined : surfaces.get(handle)
  if (named != null) return named
  if (intent?.buffer != null) return 'tile'
  if (intent?.preview === true) return 'card'
  return 'game'
}

/** Where a player was asked to start. */
export function startOf(
  intent:
    | Pick<PlayIntent, 'buffer' | 'isLive' | 'startAtLiveEdge' | 'startSec'>
    | undefined
): PlaybackStart {
  // A buffered tile is placed by its grid, and a start or a refusal of the
  // live edge is a place of the caller's: only a bare live attachment joins
  // the edge (attachHls joins it only without a buffer).
  if (
    intent?.startSec != null ||
    intent?.buffer != null ||
    intent?.startAtLiveEdge === false
  )
    return 'position'
  return intent?.isLive != null ? 'live_edge' : 'start'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100))
}

/** A finite number put inside a property's bounds, or nothing. */
function bounded(
  value: number | null | undefined,
  min: number,
  max: number
): number | undefined {
  return value == null || !Number.isFinite(value)
    ? undefined
    : clamp(value, min, max)
}

/** The parts of a player beyond `VideoHandle` that some platforms have. */
interface Extras {
  readonly buffered?: {
    readonly length: number
    start: (index: number) => number
    end: (index: number) => number
  }
  readonly bufferedEnd?: number | null
  readonly error?: { readonly code: number } | null
  readonly lastError?: unknown
  /** A line throughput estimate the player keeps itself (ExoPlayer). */
  readonly bandwidthEstimate?: number | null
  /** The bitrate of the stream the player says it plays (AVPlayer). */
  readonly streamBitrate?: number | null
  getVideoPlaybackQuality?: () => {
    droppedVideoFrames: number
    totalVideoFrames: number
  }
}

/** Seconds buffered ahead of the playhead, where the player says. */
export function bufferedAheadOf(handle: VideoHandle): number | undefined {
  const extras = handle as VideoHandle & Extras
  const at = handle.currentTime
  const ranges = extras.buffered
  if (ranges != null) {
    for (let index = 0; index < ranges.length; index++) {
      const start = ranges.start(index)
      const end = ranges.end(index)
      if (at >= start - 0.5 && at <= end + 0.5) return end - at
    }
    return ranges.length > 0 ? 0 : undefined
  }
  const end = extras.bufferedEnd
  return end == null || !Number.isFinite(end) ? undefined : end - at
}

const MEDIA_ERRORS: Record<number, PlaybackErrorKind> = {
  1: 'media_aborted',
  2: 'media_network',
  3: 'media_decode',
  4: 'media_unsupported'
}

/** A phone player's error code, from whichever field its platform fills. */
export function nativeErrorCode(error: unknown): number | undefined {
  const detail =
    error != null && typeof error === 'object' && 'error' in error
      ? error.error
      : error
  if (detail == null || typeof detail !== 'object') return undefined
  for (const field of ['code', 'errorCode']) {
    const raw = (detail as Record<string, unknown>)[field]
    const value = typeof raw === 'string' ? Number(raw) : raw
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** hls.js's camel-case error detail as one of the reported few. */
export function hlsDetail(details: unknown): string {
  if (typeof details !== 'string') return 'other'
  const snake = details.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase())
  return (PLAYBACK_ERROR_DETAILS as readonly string[]).includes(snake)
    ? snake
    : 'other'
}

/** hls.js's error type as a reported kind. */
export function hlsKind(type: unknown): PlaybackErrorKind {
  switch (type) {
    case 'networkError':
      return 'hls_network'
    case 'mediaError':
      return 'hls_media'
    case 'muxError':
      return 'hls_mux'
    case 'keySystemError':
      return 'hls_key'
    default:
      return 'hls_other'
  }
}

const ALWAYS: ReadonlySet<EventName> = new Set<EventName>([
  'playback_attached',
  'playback_first_frame',
  'playback_first_frame_missed',
  'playback_detached'
])

const LISTENED = [
  'loadedmetadata',
  'canplay',
  'play',
  'pause',
  'playing',
  'waiting',
  'seeking',
  'seeked',
  'timeupdate',
  'progress',
  'error'
] as const

export class PlaybackSession {
  readonly id: string
  private readonly attachedAt: number
  private readonly rate: RateLimit
  private sent = 0
  private readonly routineRate: RateLimit
  private routineSent = 0
  private readonly seekRate: RateLimit
  private seeksSent = 0
  private dropped = 0
  private ended = false
  private metadataCount = 0
  private canplayCount = 0
  private firstFrameAt: number | null = null
  private pendingMs: number | undefined
  private playRefused = false
  private lastPos: number | null = null
  private lastEnd: number | null = null
  private lastTickAt: number | null = null
  private watchedMs = 0
  private stallStartedAt: number | null = null
  private stalls = 0
  private stallMs = 0
  private reloads = 0
  private seekFrom: {
    kind: SeekKind
    from: number
    behind?: number
    at: number
  } | null = null

  private targetSec: number | undefined
  private bandwidthBps: number | undefined
  private bitrateBps: number | undefined
  private beatAt: number
  /** When a play was first asked for, the start of the first frame's wait. */
  private askedAt: number | null = null
  private missedSaid = false
  private readonly listeners: Array<[(typeof LISTENED)[number], () => void]>

  constructor(
    private readonly handle: VideoHandle,
    private readonly description: PlaybackDescription,
    private readonly emit: PlaybackEmit = emitAppLog,
    private readonly clock: PlaybackClock = Date.now,
    makeId: () => string = randomUuid
  ) {
    this.id = makeId()
    this.attachedAt = clock()
    this.beatAt = this.attachedAt
    this.rate = new RateLimit(PER_MINUTE_CAP, clock)
    this.routineRate = new RateLimit(ROUTINE_PER_MINUTE_CAP, clock)
    this.seekRate = new RateLimit(SEEK_PER_MINUTE_CAP, clock)
    sessions.set(handle, this)
    this.send('playback_attached', {
      si: description.start,
      ...this.place()
    })
    this.listeners = LISTENED.map(name => {
      const listener = (): void => {
        try {
          this.on(name)
        } catch {
          /* Reporting must not change playback. */
        }
      }
      handle.addEventListener(name, listener)
      return [name, listener]
    })
    if (!handle.paused) this.askedAt = this.attachedAt
  }

  /** Seconds since attach, as a property value. */
  private sinceAttach(): number {
    return clamp(this.clock() - this.attachedAt, 0, MAX_MS)
  }

  private send(
    event: EventName,
    properties: Record<string, Property | undefined>,
    level: Level = 'info'
  ): void {
    if (this.ended && event !== 'playback_detached') return
    const routine =
      event === 'playback_heartbeat' ||
      event === 'playback_bitrate' ||
      (event === 'playback_error' && properties.ft === false)
    if (routine) {
      if (
        this.routineSent >= ROUTINE_SESSION_CAP ||
        !this.routineRate.allow(this.id)
      ) {
        this.dropped += 1
        return
      }
      this.routineSent += 1
    } else if (event === 'playback_seek') {
      if (this.seeksSent >= SEEK_SESSION_CAP || !this.seekRate.allow(this.id)) {
        this.dropped += 1
        return
      }
      this.seeksSent += 1
    } else if (!ALWAYS.has(event)) {
      if (this.sent >= SESSION_EVENT_CAP || !this.rate.allow(this.id)) {
        this.dropped += 1
        return
      }
      this.sent += 1
    }
    const clean: Record<string, Property> = {
      ps: this.id,
      en: this.description.engine,
      sf: this.description.surface,
      lv: this.description.live
    }
    if (this.description.videoId != null) clean.vi = this.description.videoId
    for (const [key, value] of Object.entries(properties))
      if (value !== undefined) clean[key] = value
    try {
      this.emit(event, clean, level)
    } catch {
      /* Reporting must not change playback. */
    }
  }

  /** Where the playhead is, how far behind live and how much is loaded ahead. */
  private place(): Record<string, number | undefined> {
    const pos = this.handle.currentTime
    const end = seekableEndOf(this.handle)
    return {
      pos: bounded(pos, 0, 604800),
      be:
        this.description.live && end != null
          ? bounded(end - pos, -600, 604800)
          : undefined,
      ba: bounded(bufferedAheadOf(this.handle), -600, 3600),
      td: bounded(this.targetSec, 0, 60)
    }
  }

  /** A first frame asked for and still not shown after the wait is said, once. */
  private checkMissed(now: number): void {
    if (
      this.missedSaid ||
      this.firstFrameAt != null ||
      this.askedAt == null ||
      now - this.askedAt < FIRST_FRAME_WAIT_MS
    )
      return
    this.missedSaid = true
    this.send(
      'playback_first_frame_missed',
      {
        ms: clamp(now - this.attachedAt, 0, MAX_MS),
        pms: this.pendingMs,
        rl: this.reloads,
        pr: this.playRefused,
        ...this.place()
      },
      'warn'
    )
  }

  private on(name: (typeof LISTENED)[number]): void {
    const handle = this.handle
    const now = this.clock()
    if (this.seekFrom != null && now - this.seekFrom.at > SEEK_STALE_MS)
      this.seekFrom = null
    this.checkMissed(now)
    switch (name) {
      case 'loadedmetadata': {
        this.metadataCount += 1
        this.send('playback_metadata', {
          ms: this.sinceAttach(),
          dur: bounded(handle.duration, 0, 604800),
          wd: bounded(handle.videoWidth, 0, 16384),
          ht: bounded(handle.videoHeight, 0, 16384),
          n: this.metadataCount
        })
        return
      }
      case 'canplay': {
        this.canplayCount += 1
        // Every canplay after the first is a reload's or a seek's: only
        // a reload's says anything new, and the reload is reported itself.
        if (this.canplayCount > 1) return
        this.send('playback_canplay', { ms: this.sinceAttach() })
        return
      }
      case 'play':
        this.askedAt ??= now
        return
      case 'pause':
        // A pause ends a stall rather than lengthening it, and one before the
        // first frame ends the wait for it: the next play starts it again.
        this.endStall(now)
        if (this.firstFrameAt == null) this.askedAt = null
        return
      case 'playing':
        // A phone's player can say it plays again without a `seeked` for a
        // seek it made itself: playing is the seek's end.
        if (this.seekFrom != null) this.finishSeek()
        this.endStall(now)
        return
      case 'waiting': {
        // Buffering a seek asked for is the seek's, reported with it, not a
        // stall; nor is a paused player's stop (a phone's player says "not
        // playing" for a pause too).
        if (
          this.firstFrameAt == null ||
          this.stallStartedAt != null ||
          this.seekFrom != null ||
          handle.paused
        )
          return
        this.stallStartedAt = now
        this.stalls += 1
        this.send(
          'playback_stall_started',
          { sr: 'waiting', ...this.place() },
          'warn'
        )
        return
      }
      case 'seeking': {
        // A seek that is itself overtaken is reported from its first start.
        if (this.seekFrom != null) return
        const from = this.lastPos ?? handle.currentTime
        this.seekFrom = {
          kind: takeMark(handle, now),
          at: now,
          from,
          behind:
            this.description.live && this.lastEnd != null
              ? this.lastEnd - from
              : undefined
        }
        return
      }
      case 'seeked':
        this.finishSeek()
        return
      case 'timeupdate': {
        const pos = handle.currentTime
        // A jump while a seek is open is the seek, not playback.
        const moved =
          this.seekFrom == null &&
          this.lastPos != null &&
          Math.abs(pos - this.lastPos) >= MOVED_SEC
        if (!handle.paused && this.lastTickAt != null && moved)
          this.watchedMs += Math.min(TICK_CAP_MS, now - this.lastTickAt)
        this.lastTickAt = now
        if (this.seekFrom == null) this.lastPos = pos
        this.lastEnd = seekableEndOf(handle)
        if (moved && !handle.paused) {
          this.endStall(now)
          if (this.firstFrameAt == null) this.firstFrame(now)
        }
        if (now - this.beatAt >= HEARTBEAT_MS) {
          this.beatAt = now
          this.beat()
        }
        return
      }
      case 'progress':
        // Only the first-frame check above: loading says nothing new itself.
        return
      case 'error':
        this.elementError()
    }
  }

  /** The open seek has landed: report it from where it began. */
  private finishSeek(): void {
    const seek = this.seekFrom
    this.seekFrom = null
    if (seek == null) return
    const { pos, be } = this.place()
    this.send('playback_seek', {
      sk: seek.kind,
      fr: bounded(seek.from, 0, 604800),
      to: pos,
      bb: bounded(seek.behind, -600, 604800),
      bf: be
    })
    this.lastPos = this.handle.currentTime
  }

  private firstFrame(now: number): void {
    this.firstFrameAt = now
    this.send('playback_first_frame', {
      ms: clamp(now - this.attachedAt, 0, MAX_MS),
      pms: this.pendingMs,
      rl: this.reloads,
      pr: this.playRefused,
      ...this.place()
    })
  }

  private endStall(now: number): void {
    const started = this.stallStartedAt
    if (started == null) return
    this.stallStartedAt = null
    const ms = Math.max(0, now - started)
    this.stallMs += ms
    this.send('playback_stall_ended', {
      ms: clamp(ms, 0, MAX_MS),
      ...this.place()
    })
  }

  private elementError(): void {
    const extras = this.handle as VideoHandle & Extras
    const { engine } = this.description
    if (engine === 'avplayer' || engine === 'exoplayer') {
      this.error(engine, nativeErrorCode(extras.lastError), true)
      return
    }
    const code = extras.error?.code
    // An aborted load is the player's own doing, not a failure.
    if (code == null || code === 1) return
    this.error(MEDIA_ERRORS[code] ?? 'unknown', code, true)
  }

  private error(
    kind: PlaybackErrorKind,
    code: number | undefined,
    fatal: boolean,
    detail?: string
  ): void {
    this.send(
      'playback_error',
      {
        ek: kind,
        ed: detail,
        cd: bounded(code, -1e10, 1e10),
        ft: fatal,
        ...this.place()
      },
      fatal ? 'error' : 'warn'
    )
  }

  private beat(): void {
    if (this.ended || this.handle.paused) return
    const extras = this.handle as VideoHandle & Extras
    let quality:
      { droppedVideoFrames: number; totalVideoFrames: number } | undefined
    try {
      quality = extras.getVideoPlaybackQuality?.()
    } catch {}
    this.send('playback_heartbeat', {
      rt: bounded(this.handle.playbackRate, -16, 16),
      bw: bounded(
        this.bandwidthBps ?? extras.bandwidthEstimate ?? undefined,
        0,
        1e11
      ),
      br: bounded(
        this.bitrateBps ?? extras.streamBitrate ?? undefined,
        0,
        1e10
      ),
      df: bounded(quality?.droppedVideoFrames, 0, 1e9),
      tf: bounded(quality?.totalVideoFrames, 0, 1e9),
      pl: this.firstFrameAt != null && this.stallStartedAt == null,
      wms: bounded(this.watchedMs, 0, MAX_MS),
      sc: this.stalls,
      ...this.place()
    })
  }

  /** The playlist was handed to the player. */
  sourceSet(): void {
    this.seekFrom = null
    this.send('playback_source_set', { ms: this.sinceAttach() })
  }

  /** How long the caller waited for an address before this attachment. */
  pending(ms: number): void {
    this.pendingMs = bounded(ms, 0, 86400000)
  }

  /** A `play()` the browser refused: muted autoplay disallowed, say. */
  refused(): void {
    if (this.playRefused) return
    this.playRefused = true
    this.send(
      'playback_error',
      { ek: 'unknown', ed: 'other', ft: false, pr: true },
      'warn'
    )
  }

  /** An hls.js error, fatal or not. */
  hlsError(type: unknown, details: unknown, fatal: boolean): void {
    this.error(hlsKind(type), undefined, fatal, hlsDetail(details))
  }

  /** A recovery the player made, or its giving up. */
  recovery(kind: RecoveryKind, count?: number): void {
    const reloading = RELOADING.has(kind)
    if (reloading) this.reloads += 1
    if (kind !== 'give_up') this.seekFrom = null
    // `n` is the caller's count; a reload with none says how many so far.
    // Any other recovery with no count of its own sends none.
    this.send(
      'playback_recovery',
      {
        rk: kind,
        n: bounded(count ?? (reloading ? this.reloads : undefined), 0, 1e9),
        ...this.place()
      },
      kind === 'give_up' ? 'error' : 'warn'
    )
  }

  /** The playlist's segment target duration, when the player reads it. */
  targetDuration(seconds: number): void {
    this.targetSec = bounded(seconds, 0, 60)
  }

  /** The player's estimate of the line, in bits a second. */
  bandwidth(bps: number): void {
    this.bandwidthBps = bounded(bps, 0, 1e11)
  }

  /** The stream's bitrate now playing, in bits a second, reported on change. */
  bitrate(bps: number): void {
    const value = bounded(bps, 0, 1e10)
    if (value == null || value === 0) return
    const before = this.bitrateBps
    this.bitrateBps = value
    if (before != null && Math.abs(value - before) <= before * BITRATE_CHANGE)
      return
    this.send('playback_bitrate', { br: value })
  }

  /** The attachment is over: what it amounted to. */
  detach(): void {
    if (this.ended) return
    const now = this.clock()
    this.checkMissed(now)
    this.endStall(now)
    this.send('playback_detached', {
      ms: this.sinceAttach(),
      wms: bounded(this.watchedMs, 0, MAX_MS),
      sc: this.stalls,
      sms: bounded(this.stallMs, 0, MAX_MS),
      rl: this.reloads,
      n: this.dropped,
      ...this.place()
    })
    this.ended = true
    for (const [name, listener] of this.listeners)
      this.handle.removeEventListener(name, listener)
    if (sessions.get(this.handle) === this) sessions.delete(this.handle)
  }
}

/** Starts watching a player, or nothing if the logging itself fails. */
export function startPlayback(
  handle: VideoHandle,
  description: PlaybackDescription,
  emit?: PlaybackEmit,
  clock?: PlaybackClock
): PlaybackSession | undefined {
  try {
    return new PlaybackSession(handle, description, emit, clock)
  } catch {
    return undefined
  }
}
