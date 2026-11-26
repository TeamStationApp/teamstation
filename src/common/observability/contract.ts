import { SERVER_CODE_FILES } from './serverCodeFiles'

/** Compact wire format. D is deliberately inserted first by every serializer. */
const errorClasses = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'NSException',
  'NSInvalidArgumentException',
  'IllegalStateException',
  'IllegalArgumentException',
  'RuntimeException',
  'OutOfMemoryError',
  'SIGABRT',
  'SIGSEGV',
  'EXC_BAD_ACCESS'
])
const codeFiles = new Set([
  'App.tsx',
  'api.ts',
  'sentry.ts',
  'index.ts',
  'VideoView.tsx',
  'VideoView.native.tsx',
  'MultiCamView.tsx',
  'StreamingScreen.native.tsx',
  'SentrySetup.swift',
  'SentrySetup.kt',
  'MainActivity.kt',
  'RecordingEngine.swift',
  'DistributorModel.swift'
])
export function errorClass(value: unknown): value is string {
  return typeof value === 'string' && errorClasses.has(value)
}
export function codeFile(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (codeFiles.has(value) ||
      SERVER_CODE_FILES.has(value) ||
      /^(?:app-[A-Z0-9]{8}\.js|index\.android\.bundle|main\.jsbundle)$/.test(
        value
      ))
  )
}
export const APPS = [
  'TS',
  'TS web',
  'TS dir',
  'cam',
  'TS dist',
  'TS srv'
] as const
export type AppCode = (typeof APPS)[number]
export const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const
export type Level = (typeof LEVELS)[number]
export type Property = string | number | boolean
type Rule = (value: unknown) => value is Property

const choice =
  (...values: string[]): Rule =>
  (value): value is string =>
    typeof value === 'string' && values.includes(value)
const number =
  (max: number, min = 0): Rule =>
  (value): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
const boolean: Rule = (value): value is boolean => typeof value === 'boolean'
const id: Rule = (value): value is string =>
  typeof value === 'string' &&
  /^(?:vid|gam|tem|sea|lea|dup|liv)_[A-Za-z0-9_-]{1,96}$/.test(value)
const uuid: Rule = (value): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
// SDK event IDs are opaque 128-bit hex values; native crash IDs need not carry UUID variant bits.
const eventId: Rule = (value): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const error = choice(
  'invalid',
  'expired',
  'rate_limited',
  'offline',
  'internal',
  'timeout',
  'permission',
  'storage',
  'cancelled',
  'unknown'
)
const method = choice('email_code', 'password', 'link', 'oauth')
const step = choice('email', 'code', 'password', 'name', 'photo', 'complete')
/** Route names only. No URL, path parameters, chat routes or typed values. */
export const PAGE_NAMES = [
  'home',
  'discover',
  'login',
  'onboarding',
  'account',
  'game',
  'player',
  'team',
  'season',
  'league',
  'group',
  'person',
  'join',
  'create',
  'notifications',
  'settings',
  'scoring',
  'stream',
  'other'
] as const
const page = { pg: choice(...PAGE_NAMES), ms: number(86400000) }
const funnel = { mt: method, sp: step, ec: error }
const entity = {
  id,
  ty: choice('team', 'season', 'league', 'game'),
  ok: boolean,
  ec: error
}
const video = {
  vi: ((value): value is string =>
    typeof value === 'string' &&
    /^vid_[A-Za-z0-9_-]{1,96}$/.test(value)) as Rule,
  ps: uuid,
  ms: number(15000),
  pos: number(604800),
  dur: number(604800),
  rt: number(16, -16),
  bytes: number(1e13),
  ec: error
}
const operation = choice(
  'signup',
  'login',
  'onboarding',
  'navigation',
  'search',
  'follow',
  'join',
  'invite',
  'create',
  'record',
  'upload',
  'playback',
  'export',
  'service',
  'request',
  'assistant',
  'other'
)
export const REQUEST_ROUTES = [
  '/auth/password',
  '/auth/code',
  '/auth/signup',
  '/onboarding',
  '/analytics/events',
  '/admin/analytics/query',
  '/health',
  '/games/:gameId',
  '/videos/:videoId',
  '/videos/:videoId/playback',
  '/videos/:videoId/hls/:file',
  '/videos/:videoId/stills/:file',
  '/videos/:videoId/still',
  '/videos/:videoId/wall-timeline',
  '/live',
  '/games/:gameId/live-streams',
  '/games/:gameId/live-streams/:streamId',
  '/games/:gameId/stream-access',
  '/director/uploads',
  '/me/tess/messages',
  'other'
] as const
const system = {
  op: operation,
  rp: choice(...REQUEST_ROUTES),
  mt: choice(
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
    'OTHER'
  ),
  ec: error,
  status: number(599, 100),
  ms: number(86400000),
  n: number(1e9),
  on: boolean
}

/** One Messages API call of Tess's: its tokens in and out, never the text. */
const tess = {
  op: operation,
  status: system.status,
  ms: system.ms,
  it: number(10000000),
  ot: number(10000000),
  /** Of `it`, read from the cache and written to it. */
  cr: number(10000000),
  cw: number(10000000),
  ec: error
}

/** Where a player shows: a home card, the game page, a grid, one of its tiles. */
export const PLAYBACK_SURFACES = [
  'card',
  'game',
  'grid',
  'tile',
  'other'
] as const
export type PlaybackSurface = (typeof PLAYBACK_SURFACES)[number]
/** Who plays the stream: the browser, hls.js, AVPlayer or ExoPlayer. */
export const PLAYBACK_ENGINES = [
  'native',
  'hlsjs',
  'avplayer',
  'exoplayer',
  'none'
] as const
export type PlaybackEngine = (typeof PLAYBACK_ENGINES)[number]
/** What moved the playhead. */
export const SEEK_KINDS = [
  'scrub',
  'jump_to_present',
  'seek_by',
  'cushion_join',
  'restore',
  'stall_recovery',
  'reload_restore',
  'other'
] as const
export type SeekKind = (typeof SEEK_KINDS)[number]
/** A player's failure, by source: the element's MediaError, hls.js, or a phone's player. */
export const PLAYBACK_ERROR_KINDS = [
  'media_aborted',
  'media_network',
  'media_decode',
  'media_unsupported',
  'hls_network',
  'hls_media',
  'hls_mux',
  'hls_key',
  'hls_other',
  'avplayer',
  'exoplayer',
  'unknown'
] as const
export type PlaybackErrorKind = (typeof PLAYBACK_ERROR_KINDS)[number]
/** hls.js error details worth telling apart, in snake case; the rest are `other`. */
export const PLAYBACK_ERROR_DETAILS = [
  'manifest_load_error',
  'manifest_load_timeout',
  'manifest_parsing_error',
  'level_load_error',
  'level_load_timeout',
  'level_empty_error',
  'frag_load_error',
  'frag_load_timeout',
  'frag_parsing_error',
  'frag_gap',
  'buffer_append_error',
  'buffer_appending_error',
  'buffer_stalled_error',
  'buffer_full_error',
  'buffer_nudge_on_stall',
  'buffer_seek_over_hole',
  'internal_exception',
  'other'
] as const
/** What a player did to come back, or that it stopped trying. */
export const RECOVERY_KINDS = [
  'reload',
  'new_address',
  'playlist_watch_reload',
  'rejoin',
  'give_up',
  'media_recover',
  'network_retry',
  'stall_reload',
  'restore_abandoned'
] as const
export type RecoveryKind = (typeof RECOVERY_KINDS)[number]
const behind = number(604800, -600)
/**
 * One player attachment's telemetry, joined by `ps`. Positions and distances
 * are seconds; `be` is how far behind the newest seekable footage, `ba` how
 * much is buffered ahead. No URL, token or address ever goes in.
 */
const playback = {
  vi: video.vi,
  ps: uuid,
  en: choice(...PLAYBACK_ENGINES),
  sf: choice(...PLAYBACK_SURFACES),
  lv: boolean,
  si: choice('live_edge', 'position', 'start'),
  ms: number(86400000),
  pms: number(86400000),
  pos: video.pos,
  dur: video.dur,
  be: behind,
  ba: number(3600, -600),
  td: number(60),
  sr: choice('waiting', 'stalled', 'buffer'),
  sk: choice(...SEEK_KINDS),
  fr: video.pos,
  to: video.pos,
  bb: behind,
  bf: behind,
  ek: choice(...PLAYBACK_ERROR_KINDS),
  ed: choice(...PLAYBACK_ERROR_DETAILS),
  cd: number(1e10, -1e10),
  ft: boolean,
  rk: choice(...RECOVERY_KINDS),
  n: number(1e9),
  wms: number(86400000),
  sc: number(1e6),
  sms: number(86400000),
  rl: number(1e6),
  rt: video.rt,
  bw: number(1e11),
  br: number(1e10),
  df: number(1e9),
  tf: number(1e9),
  pl: boolean,
  pr: boolean,
  wd: number(16384),
  ht: number(16384)
}
/** A playback or live-list request as a player screen saw it. */
const playbackFetch = {
  vi: video.vi,
  sf: choice(...PLAYBACK_SURFACES),
  fk: choice('playback', 'live_now'),
  oc: choice('ok', 'pending', 'unavailable', 'error', 'offline'),
  status: number(599, 100),
  ms: number(86400000),
  at: number(1e6),
  rd: number(86400000),
  n: number(1e6)
}

const rateTier = choice(
  'none',
  'ordinary',
  'aggregate',
  'expensive',
  'rows',
  'arrival'
)
const rateScope = choice(
  'arrivalIp',
  'signedInIp',
  'guestIp',
  'account',
  'store'
)
const rateCount = number(Number.MAX_SAFE_INTEGER)

/** The property dictionary is positive: unknown fields never leave a client. */
export const EVENT_RULES = {
  session_started: {},
  session_ended: { ms: number(86400000) },
  app_foreground: {},
  app_background: {},
  page_viewed: page,
  page_left: page,
  signup_started: funnel,
  signup_step_viewed: funnel,
  signup_step_completed: funnel,
  signup_step_failed: funnel,
  account_created: {},
  onboarding_completed: {},
  login_started: funnel,
  login_succeeded: funnel,
  login_failed: funnel,
  logout: {},
  search_submitted: { n: number(1000000) },
  group_viewed: entity,
  follow_changed: entity,
  join_requested: entity,
  invite_accepted: entity,
  group_created: entity,
  event_created: entity,
  recording_requested: video,
  recording_started: video,
  recording_stopped: video,
  recording_failed: video,
  upload_started: video,
  upload_completed: video,
  upload_failed: video,
  upload_retry: video,
  processing_ready: video,
  processing_failed: video,
  video_started: video,
  video_paused: video,
  video_resumed: video,
  video_seeked: video,
  video_buffering_started: video,
  video_buffering_ended: video,
  video_completed: video,
  video_left: video,
  watch_progress: video,
  api_failed: system,
  app_error: {
    ...system,
    c: errorClass,
    f0: codeFile,
    l0: number(1000000, 1),
    c0: number(100000000, 0),
    f1: codeFile,
    l1: number(1000000, 1),
    c1: number(100000000, 0),
    f2: codeFile,
    l2: number(1000000, 1),
    c2: number(100000000, 0)
  },
  offline_changed: { on: boolean },
  service_started: system,
  service_stopped: system,
  stream_started: system,
  stream_stopped: system,
  stream_failed: system,
  request_completed: system,
  api_rate_decisions: {
    mode: choice('observe', 'enforce'),
    tier: rateTier,
    transport: choice('http', 'upgrade', 'search'),
    backend: choice('shared', 'local'),
    scope: rateScope,
    limitingTier: rateTier,
    decision: choice('refused', 'admitted'),
    fault: choice(
      'none',
      'unavailable',
      'timeout',
      'permissions',
      'readOnly',
      'cluster',
      'storeError'
    ),
    n: rateCount,
    units: rateCount,
    admittedUnits: rateCount,
    le1: rateCount,
    le5: rateCount,
    le20: rateCount,
    le100: rateCount
  },
  api_rate_demand: {
    mode: choice('observe', 'enforce'),
    scope: rateScope,
    tier: rateTier,
    windowSec: number(60),
    n: rateCount,
    p50: rateCount,
    p95: rateCount,
    max: rateCount
  },
  api_rate_upgrade_identity_missed: { n: rateCount },
  api_rate_store: { mode: choice('observe', 'enforce'), degradedMs: rateCount },
  export_started: system,
  export_completed: system,
  export_failed: system,
  tess_request: tess,
  queue_dropped: { n: number(1e9) },
  playback_attached: playback,
  playback_source_set: playback,
  playback_metadata: playback,
  playback_canplay: playback,
  playback_first_frame: playback,
  playback_first_frame_missed: playback,
  playback_stall_started: playback,
  playback_stall_ended: playback,
  playback_seek: playback,
  playback_error: playback,
  playback_recovery: playback,
  playback_heartbeat: playback,
  playback_bitrate: playback,
  playback_detached: playback,
  playback_fetch: playbackFetch
} satisfies Record<string, Record<string, Rule>>
export type EventName = keyof typeof EVENT_RULES
export const ANONYMOUS_EVENTS = new Set<EventName>([
  'session_started',
  'session_ended',
  'app_foreground',
  'app_background',
  'page_viewed',
  'page_left',
  'signup_started',
  'signup_step_viewed',
  'signup_step_completed',
  'signup_step_failed',
  'login_started',
  'login_failed',
  'offline_changed'
])
export const SERVER_EVENTS = new Set<EventName>([
  'account_created',
  'processing_ready',
  'processing_failed',
  'tess_request',
  'api_rate_decisions',
  'api_rate_demand',
  'api_rate_upgrade_identity_missed',
  'api_rate_store'
])
/**
 * How OpenSearch stores each property any event may carry. The collector's
 * strict mapping is built from this, so a property added to a rule above and
 * not here is refused by the index rather than silently dropped later.
 */
export const PROPERTY_TYPES: Readonly<
  Record<string, 'keyword' | 'double' | 'boolean'>
> = {
  mode: 'keyword',
  tier: 'keyword',
  transport: 'keyword',
  backend: 'keyword',
  scope: 'keyword',
  limitingTier: 'keyword',
  decision: 'keyword',
  fault: 'keyword',
  units: 'double',
  admittedUnits: 'double',
  le1: 'double',
  le5: 'double',
  le20: 'double',
  le100: 'double',
  windowSec: 'double',
  p50: 'double',
  p95: 'double',
  max: 'double',
  degradedMs: 'double',
  pg: 'keyword',
  mt: 'keyword',
  sp: 'keyword',
  ec: 'keyword',
  id: 'keyword',
  ty: 'keyword',
  vi: 'keyword',
  ps: 'keyword',
  op: 'keyword',
  rp: 'keyword',
  c: 'keyword',
  f0: 'keyword',
  f1: 'keyword',
  f2: 'keyword',
  en: 'keyword',
  sf: 'keyword',
  si: 'keyword',
  sr: 'keyword',
  sk: 'keyword',
  ek: 'keyword',
  ed: 'keyword',
  rk: 'keyword',
  fk: 'keyword',
  oc: 'keyword',
  ms: 'double',
  pos: 'double',
  dur: 'double',
  rt: 'double',
  bytes: 'double',
  status: 'double',
  n: 'double',
  l0: 'double',
  l1: 'double',
  l2: 'double',
  c0: 'double',
  c1: 'double',
  c2: 'double',
  it: 'double',
  ot: 'double',
  cr: 'double',
  cw: 'double',
  pms: 'double',
  be: 'double',
  ba: 'double',
  td: 'double',
  fr: 'double',
  to: 'double',
  bb: 'double',
  bf: 'double',
  cd: 'double',
  wms: 'double',
  sc: 'double',
  sms: 'double',
  rl: 'double',
  bw: 'double',
  br: 'double',
  df: 'double',
  tf: 'double',
  wd: 'double',
  ht: 'double',
  at: 'double',
  rd: 'double',
  ok: 'boolean',
  on: 'boolean',
  lv: 'boolean',
  ft: 'boolean',
  pl: 'boolean',
  pr: 'boolean'
}
export const MAX_EVENT_BYTES = 4096
export const MAX_AGE_MS = 7 * 86400000

export interface EventRecord {
  D: string
  A: AppCode
  I: string
  E: EventName
  L: Level
  R: 1
  P: Record<string, Property>
  V?: string
  S?: string
  /** Authenticated server operational attribution; public ingestion cannot assert it. */
  U?: string
}

function object(value: unknown): value is Record<string, unknown> {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
}

/** UTF-8 bytes without a Node-only Buffer dependency in mobile code. */
export function bytes(text: string): number {
  let size = 0
  for (const character of text) {
    const point = character.codePointAt(0)!
    size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return size
}

/** Reject a whole unsafe event, rather than quietly storing a misleading subset. */
export function parseEvent(value: unknown, now = Date.now()): EventRecord {
  if (
    !object(value) ||
    Object.keys(value).some(
      key => !['D', 'A', 'I', 'E', 'L', 'R', 'P', 'V', 'S', 'U'].includes(key)
    )
  )
    throw new Error('Invalid event fields')
  const { D, A, I, E, L, R, P, V, S, U } = value
  if (
    typeof D !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(D)
  )
    throw new Error('Invalid event date')
  const at = Date.parse(D)
  if (
    !Number.isFinite(at) ||
    new Date(at).toISOString() !== D ||
    at < now - MAX_AGE_MS ||
    at > now + 300000
  )
    throw new Error('Event date outside allowed window')
  if (
    !APPS.includes(A as AppCode) ||
    !eventId(I) ||
    typeof E !== 'string' ||
    !Object.hasOwn(EVENT_RULES, E) ||
    !LEVELS.includes(L as Level) ||
    R !== 1 ||
    !object(P)
  )
    throw new Error('Invalid event envelope')
  const rules: Record<string, Rule> = EVENT_RULES[E as EventName]
  const properties: Record<string, Property> = {}
  for (const [key, item] of Object.entries(P)) {
    if (!Object.hasOwn(rules, key) || !rules[key](item))
      throw new Error('Invalid event property')
    properties[key] = item
  }
  if (E.startsWith('video_') || E === 'watch_progress') {
    if (properties.vi == null || properties.ps == null)
      throw new Error('Video identity required')
  }
  if (
    E.startsWith('playback_') &&
    E !== 'playback_fetch' &&
    properties.ps == null
  )
    throw new Error('Playback session required')
  if (E === 'watch_progress' && properties.ms == null)
    throw new Error('Watch delta required')
  if (
    V !== undefined &&
    (typeof V !== 'string' || !/^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(V))
  )
    throw new Error('Invalid build version')
  if (S !== undefined && !uuid(S)) throw new Error('Invalid session ID')
  if (U !== undefined && (A !== 'TS srv' || userId(U) === undefined))
    throw new Error('Invalid operational actor')
  const event: EventRecord = {
    D,
    A: A as AppCode,
    I: I as string,
    E: E as EventName,
    L: L as Level,
    R: 1,
    P: properties
  }
  if (V !== undefined) event.V = V
  if (S !== undefined) event.S = S as string
  if (U !== undefined) event.U = U as string
  // The finite key set and bounded property values keep every event below
  // MAX_EVENT_BYTES; there is no unrestricted string to truncate here.
  return event
}

/** Each returned line begins with D and has exactly one terminal newline. */
export function jsonLine(event: EventRecord, now = Date.now()): string {
  return JSON.stringify(parseEvent(event, now)) + '\n'
}

export function parseBatch(text: string, now = Date.now()): EventRecord[] {
  if (bytes(text) > 65536) throw new Error('Batch too large')
  const lines = text.trim().split('\n')
  if (lines.length > 50 || text.trim() === '')
    throw new Error('Invalid batch size')
  return lines.map(line => parseEvent(JSON.parse(line), now))
}

/** Identity is assigned outside the wire envelope, never accepted from clients. */
export function userId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^(?:[1-9][0-9]{0,19}|usr_[A-Za-z0-9_-]{1,96})$/.test(value)
    ? value
    : undefined
}
