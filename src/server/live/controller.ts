import { readFileSync, writeFileSync } from 'fs'
import { mkdir, readFile, rm, stat } from 'fs/promises'
import { type Kysely, sql } from 'kysely'
import { join } from 'path'

import { canFilm, roleScopes } from '../access'
import { hashToken } from '../auth/tokens'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { freeBytes, roomToRecord } from '../media/diskSpace'
import { ffprobeFor, probeDuration, VIDEO_FILE } from '../media/ffmpeg'
import { posterSecond } from '../media/posters'
import { presignGetUrl } from '../media/presign'
import type { SpaceSettings } from '../media/spacesHls'
import { spaceConfigured } from '../media/spacesHls'
import {
  deleteVideoFromSpace,
  uploadVideoDirectory,
  verifyVideoDirectory
} from '../media/spacesVideo'
import { ensureStill } from '../media/stills'
import {
  checkTrackStarts,
  isSoundStepProblem,
  soundStepProblem
} from '../media/trackStarts'
import { storeWallPoints } from '../media/wallTimeline'
import type { LiveSettings } from '../serverConfig'
import { noteGameFigures, noteScopeChange } from '../socket/syncRevision'
import {
  isRecordingShape,
  replaceAnchorsFromRecording,
  toRecording
} from './finishVideo'
import { OriginPublisher } from './originPublisher'
import { quietStreamCanEnd } from './quietStream'
import { openSecret } from './secrets'
import {
  clearLive,
  clearLiveSettled,
  configureIngest,
  finalSegments,
  ingestBound,
  LIVE_PLAYLIST_NAME,
  type LiveEvent,
  type LiveSpec,
  type LiveStatus,
  setLive,
  startIngest,
  statusFor,
  stopIngest
} from './splitter'
import { placeByFrameWall } from './streamKeys'
import { resumeScan, type ScanCursor, scanNewSegments } from './wallAnchors'

/**
 * What keeps the ingest and the database in step.
 *
 * The ingest holds no opinions and asks no questions: it is told which keys may
 * publish and where their video goes, and it says what happened. Everything
 * else — who owns the key, whether the window is open, what the video row
 * should say — lives here, and reaches the ingest through one short
 * synchronisation every second.
 *
 * That loop is also how the API talks to a stream. Nothing calls the ingest
 * directly: an endpoint writes the row and the next tick acts on it. It means
 * rotating a key or revoking one behaves the same
 * whether the API is one process or eight, and there is no channel between
 * them to go wrong.
 */

const SYNC_INTERVAL_MS = 1000
/** Why a stream whose recording an upload replaced was closed. */
export const REPLACED_BY_UPLOAD =
  'the recording uploaded from the phone replaced it'
/**
 * How long a publisher may be away before its viewers are told the stream
 * has finished.
 *
 * The writer never closes the playlist itself, because every player — hls.js,
 * Safari and AVPlayer, ExoPlayer — reads `EXT-X-ENDLIST` as the end of the
 * broadcast and stops asking for more, for good: a phone that lost its signal
 * for twenty seconds froze everybody watching it, even after it was back.
 * So while the publisher may yet come back the playlist stays open, and the
 * players wait at the end of it.
 *
 * Past this — eight minutes — the playlist is closed so the people watching
 * are not left waiting on a stream that has stopped. It is not the end of the
 * stream: the key still works, a publisher coming back reopens the playlist
 * and carries on in it, and the web player, which knows the video is still
 * live, picks it up again. The stream itself finishes when somebody ends it,
 * or after ten quiet minutes once the scheduled game end is ten minutes past.
 */
export const RECONNECT_GRACE_MS = 8 * 60 * 1000
/**
 * How long a video's files stay on this machine after the Space has them.
 *
 * As long as a playback token lasts, because a token already in somebody's
 * player points here. Deleting sooner would stop a game somebody is watching.
 */
const LOCAL_GRACE_MS = 6 * 3_600_000
/** How often the local copies of videos that are safely away are swept. */
const SWEEP_INTERVAL_MS = 5 * 60_000
/** How long a recording waits before the Space is tried again. */
const RETRY_AFTER_MS = 15 * 60_000

/** What a live copy's row says when its remux failed. */
const COULD_NOT_PACK = 'This recording could not be packed up'

/** How often a live stream's status snapshot is written down. */
const STATUS_WRITE_MS = 2000

export interface LiveControllerOptions {
  db: Kysely<Database>
  live: LiveSettings
  ffmpegPath: string
  /** the media root. Live HLS is written under `work/videos/<videoId>`. */
  mediaRoot: string
  /** Where stills are kept, which is where the app looks for a poster. */
  workDir: string
  sessionSecret: string
  /** Where a finished recording goes. Absent in development, and then it stays. */
  space?: SpaceSettings
  log?: (message: string) => void
  /**
   * How much room is left where recordings are written.
   *
   * Swapped out in tests, like `doFetch` on the API client. It was read
   * straight from the disk with no seam, so `sync` asked the **host** how full
   * it was — and a machine that filled up while an unrelated build was running
   * made four assertions here fail with nothing in the message to say the code
   * was fine. A test that takes the developer's free space as an input will do
   * that again.
   */
  freeBytes?: (path: string) => Promise<number>
}

interface Tracked {
  key: string
  videoId: string | null
}

let timer: NodeJS.Timeout | undefined
let sweepTimer: NodeJS.Timeout | undefined
let options: LiveControllerOptions | undefined
/** The sync still running, so a slow one is never overlapped by the next tick. */
let syncing: Promise<void> | undefined
/** The local-copy sweep still running, for a stop to wait on. */
let sweeping: Promise<void> | undefined
/** Live stream id → what the ingest was last told, so it can be untold. */
const tracked = new Map<string, Tracked>()
const lastStatusWrite = new Map<string, number>()
/** Publisher events newer than a sync's database snapshot. */
const publisherActivity = new Map<string, Date>()
/** In-flight key lookups must not restore a key removed while they awaited. */
let finalizationRevision = 0
const finalizingStreams = new Map<string, number>()
/**
 * Live stream id → the absence its playlist was closed for, as the
 * `last_published_at` it was measured from, so one absence closes it once.
 */
const closedAfterGrace = new Map<string, number>()
/** One chain per stream, so two events for one stream cannot interleave. */
const work = new Map<string, Promise<void>>()
/** Video id → how far its live wall-clock scan has got. */
const anchorCursors = new Map<string, ScanCursor>()
interface PublishingOrigin {
  publisher: OriginPublisher
  current: LiveControllerOptions
  queued: boolean
  refreshFinal: () => void
}
const origins = new Map<string, PublishingOrigin>()
let originGeneration = 0

function startOrigin(
  current: LiveControllerOptions,
  videoId: string,
  liveStreamId: string
): PublishingOrigin | undefined {
  const { space, db } = current
  if (space == null || !spaceConfigured(space)) return undefined
  const held = origins.get(videoId)
  if (held != null) return held
  let final: ReadonlySet<string> | undefined
  const publisher = new OriginPublisher({
    space,
    videoId,
    dir: liveVideoDir(current.mediaRoot, videoId),
    ffmpegPath: current.ffmpegPath,
    isFinal: name => final?.has(name) ?? true,
    rowExists: async () =>
      (await db
        .selectFrom('videos')
        .select('id')
        .where('id', '=', videoId)
        .executeTakeFirst()) != null,
    onFirstSegment: async probe => {
      await db
        .updateTable('videos')
        .set({
          storage: 'spaces',
          width: probe.width ?? null,
          height: probe.height ?? null,
          codecs: probe.codecTag,
          updated_at: new Date()
        })
        .where('id', '=', videoId)
        .where('kind', '=', 'live')
        .where('spaces_verified_at', 'is', null)
        .execute()
    }
  })
  const origin = {
    publisher,
    current,
    queued: false,
    refreshFinal: () => {
      final = finalSegments(liveStreamId)
    }
  }
  origins.set(videoId, origin)
  return origin
}

function stopOrigin(videoId: string): void {
  origins.get(videoId)?.publisher.stop()
  origins.delete(videoId)
}

function queueOrigin(videoId: string, origin: PublishingOrigin): void {
  if (origin.queued) return
  origin.queued = true
  const generation = originGeneration
  queue(`publish:${videoId}`, async () => {
    try {
      if (generation !== originGeneration) return
      const { current } = origin
      const row = await current.db
        .selectFrom('videos')
        .select('id')
        .where('id', '=', videoId)
        .executeTakeFirst()
      if (row == null) {
        await removeDeletedOrigin(current, videoId)
        return
      }
      if (origin.publisher.closing) return
      origin.refreshFinal()
      await origin.publisher.flush()
    } finally {
      origin.queued = false
    }
  })
}

/** Settles one video's origin without holding the normal controller tick. */
export async function drainPublishForTest(videoId: string): Promise<void> {
  const origin = origins.get(videoId)
  if (origin != null) queueOrigin(videoId, origin)
  await work.get(`publish:${videoId}`)
}

export function liveVideoDir(mediaRoot: string, videoId: string): string {
  return join(mediaRoot, 'work', 'videos', videoId)
}

/** How long a start waits for the RTMP port before it gives up. */
const BIND_TIMEOUT_MS = 10_000

/**
 * Starts the ingest and the loop that keeps it in step with the database.
 *
 * Nothing is touched until this process holds the RTMP port. A port somebody
 * else holds — a leftover server, another seat — means somebody else's
 * streams: resetting their rows, syncing beside them or sweeping their copies
 * would break games this process has never seen, and under a service manager
 * that retries a failed start it would do so every few seconds.
 */
export async function startLiveController(
  next: LiveControllerOptions,
  bindTimeoutMs: number = BIND_TIMEOUT_MS
): Promise<boolean> {
  options = next
  const generation = originGeneration
  const log =
    next.log ??
    ((message: string) => {
      console.log(message)
    })

  configureIngest({
    ffmpegPath: next.ffmpegPath,
    bindHost: next.live.bindHost,
    port: next.live.port,
    app: next.live.app,
    segmentSeconds: next.live.segmentSeconds,
    log,
    resolve: async key => await resolveKey(key),
    onEvent: event => {
      queue(event.key, async () => {
        if (generation === originGeneration) await handle(event)
      })
    }
  })

  // Taken before the port opens: a publisher that connects the moment it
  // does stamps its row's `last_published_at` after this, and that row is
  // its own, not a leftover. Only a publish writes that column; the API
  // writes `updated_at` on rows nobody is publishing to.
  const startedAt = new Date()
  if (!startIngest()) return false
  if (!(await ingestBound(bindTimeoutMs))) {
    log(`live ingest did not bind ${next.live.bindHost}:${next.live.port}`)
    stopIngest()
    return false
  }

  // Nothing can still be publishing to a process that has only just started.
  // A row left saying so is from the last one — a deploy, a crash — and would
  // otherwise sit there claiming a stream this ingest has never seen.
  await next.db
    .updateTable('live_streams')
    .set({ state: 'idle', updated_at: new Date() })
    .where('state', '=', 'publishing')
    .where(eb =>
      eb.or([
        eb('last_published_at', 'is', null),
        eb('last_published_at', '<', startedAt)
      ])
    )
    .execute()
    .catch((error: unknown) => {
      log(`live: ${String(error)}`)
    })

  const restoring = await next.db
    .selectFrom('live_streams')
    .innerJoin('videos', 'videos.id', 'live_streams.video_id')
    .select(['live_streams.id', 'videos.id as videoId'])
    .where('live_streams.ended_at', 'is', null)
    .where('videos.spaces_verified_at', 'is', null)
    .execute()
  for (const row of restoring) {
    if (
      (await hasMedia(next.mediaRoot, row.videoId)) &&
      generation === originGeneration
    ) {
      const origin = startOrigin(next, row.videoId, row.id)
      if (origin != null) queueOrigin(row.videoId, origin)
    }
  }

  if (generation !== originGeneration) return false
  timer = setInterval(() => {
    syncOnce(log).catch(() => {})
  }, SYNC_INTERVAL_MS)
  timer.unref?.()

  // Once on the way up as well as on the timer: a machine that was off for a
  // day comes back with a day's worth of copies to let go of, and waiting five
  // minutes to start is five minutes of disk nobody needed.
  const sweep = (): void => {
    // One at a time, like the sync: a sweep uploading a whole game over a
    // slow link outlives the tick, and a second beside it would work the
    // same rows — and be one the drain could not see.
    if (sweeping != null) return
    sweeping = sweepLocalCopies()
      .catch((error: unknown) => {
        log(`live: ${String(error)}`)
      })
      .finally(() => {
        sweeping = undefined
      })
  }
  sweep()
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
  return true
}

/**
 * Waits for what the controller already set going — each key's queued work,
 * a sync and a sweep in flight — so a stop does not close the database under
 * a write. Call after `stopLiveController`, which stops anything new from
 * starting.
 */
export async function drainLiveController(): Promise<void> {
  // Again until nothing is left: what is being waited on can queue more — a
  // finish from a sync or a sweep, an event from a writer that has just
  // exited.
  const inHand = (): Array<Promise<void>> =>
    [syncing, sweeping, ...work.values()].filter(
      (p): p is Promise<void> => p != null
    )
  for (let pending = inHand(); pending.length > 0; pending = inHand()) {
    await Promise.all(pending)
  }
}

/** Test seam: whether the sync or the sweep is on its timer. */
export function liveTimersRunningForTest(): boolean {
  return timer != null || sweepTimer != null
}

/**
 * One tick of the controller's timer: a sync, unless the last one is still
 * running. Under load a sync can take longer than the tick, and two at once
 * each read the ingest before the other wrote — the second then took a stream
 * the first had just opened for one that was no longer open, and dropped its
 * first publisher. Skipping the tick lets the next one see the settled state.
 */
export async function syncOnce(
  log: (message: string) => void,
  run: () => Promise<void> = sync
): Promise<void> {
  if (syncing != null) return
  syncing = run()
    .catch((error: unknown) => {
      log(`live: ${String(error)}`)
    })
    .finally(() => {
      syncing = undefined
    })
  await syncing
}

/**
 * Deletes the local copy of a video the Space has, once the grace is up.
 *
 * Only ever a video that is `spaces` **and** verified **and** past its
 * deadline: three conditions, because this is the one place that removes
 * something nobody can get back. The row's `local_delete_after` is cleared
 * afterwards, so the same directory is never swept twice.
 */
export async function sweepLocalCopies(
  /** The running controller's, except in a test that has its own. */
  current: LiveControllerOptions | undefined = options
): Promise<void> {
  if (current == null) return
  const generation = originGeneration
  const { db, mediaRoot } = current
  const log =
    current.log ??
    ((message: string) => {
      console.log(message)
    })
  const now = new Date()

  const rows = await db
    .selectFrom('videos')
    .select(['id'])
    .where('storage', '=', 'spaces')
    .where('spaces_verified_at', 'is not', null)
    .where('local_delete_after', '<', now)
    .limit(20)
    .execute()

  for (const row of rows) {
    const dir = liveVideoDir(mediaRoot, row.id)
    await rm(dir, { recursive: true, force: true })
    await db
      .updateTable('videos')
      .set({ local_delete_after: null, updated_at: now })
      .where('id', '=', row.id)
      .execute()
    log(`live: local copy of ${row.id} deleted; the Space has it`)
  }

  await retryTheSpace(current)
  await retryTheClose(current, generation)
}

/**
 * Tries again for a recording the Space never took.
 *
 * One a round, because the reason it failed is usually the network and there
 * is no sense in ten of them finding that out at once. A recording that is
 * still `local` an hour after it finished is one nobody is going to notice by
 * hand until the disk is full.
 */
async function retryTheSpace(current: LiveControllerOptions): Promise<void> {
  const { db, mediaRoot, space } = current
  if (space == null || !spaceConfigured(space)) return

  const stale = new Date(Date.now() - RETRY_AFTER_MS)
  // A handful rather than one, and the first of them that is actually packed
  // up. A recording the remux could not finish is left out by its message:
  // it stays `local` for ever with an `updated_at` that never moves, so it
  // would sit at the head of this order for good.
  //
  // A live copy an upload replaced is not waiting for the Space at all: it
  // was finished already replaced, so it stays here in its segments for the
  // month the replacement may be undone, with an `updated_at` that never
  // moves. Left in, five of them would fill this window for that month.
  const rows = await db
    .selectFrom('videos')
    .select(['id'])
    .where('kind', '=', 'live')
    .where('status', '=', 'ready')
    .where('storage', '=', 'local')
    .where('replaced_by', 'is', null)
    .where(eb =>
      eb.or([
        eb('status_message', 'is', null),
        eb('status_message', '<>', COULD_NOT_PACK)
      ])
    )
    .where('updated_at', '<', stale)
    .orderBy('updated_at', 'asc')
    .limit(5)
    .execute()

  // Still in its segments: never packed up at all. That is a copy finished
  // while an upload replaced it whose upload has since been deleted, which
  // brings it back, or one whose packing a restart cut short. It gets the
  // whole of what a finished stream gets, once nothing packed is waiting.
  let unpacked: string | undefined
  for (const row of rows) {
    const dir = liveVideoDir(mediaRoot, row.id)
    if (!(await isRecordingShape(dir))) {
      unpacked ??= row.id
      continue
    }
    await toTheSpace(current, row.id, dir, RECORDING_FILES)
    return
  }
  if (unpacked == null) return
  const videoId = unpacked
  // Behind any finish of the same video still running, and only if nothing
  // has replaced it or sent it in the meantime.
  queue(`publish:${videoId}`, async () => {
    const still = await db
      .selectFrom('videos')
      .select('id')
      .where('id', '=', videoId)
      .where('storage', '=', 'local')
      .where('replaced_by', 'is', null)
      .executeTakeFirst()
    if (still != null) await putAway(current, videoId)
  })
}

export function stopLiveController(): void {
  originGeneration++
  for (const origin of origins.values()) origin.publisher.stop()
  origins.clear()
  if (timer != null) {
    clearInterval(timer)
    timer = undefined
  }
  if (sweepTimer != null) {
    clearInterval(sweepTimer)
    sweepTimer = undefined
  }
  stopIngest()
  tracked.clear()
  lastStatusWrite.clear()
  publisherActivity.clear()
  anchorCursors.clear()
  closedAfterGrace.clear()
}

/**
 * One key's work, in order.
 *
 * A publish that starts and stops inside a second is not hypothetical — an
 * encoder pointed at the wrong codec does exactly that — and the two writes
 * must not race, or the row ends up saying `publishing` about a stream that
 * has already gone.
 */
function queue(key: string, task: () => Promise<void>): void {
  const previous = work.get(key) ?? Promise.resolve()
  const next: Promise<void> = previous
    .then(task)
    .catch((error: unknown) => {
      console.error(`live: ${String(error)}`)
    })
    .finally(() => {
      // The ingest lives across deploys now, for weeks: a key whose work is
      // done is let go rather than kept for ever.
      if (work.get(key) === next) work.delete(key)
    })
  work.set(key, next)
}

/** Test seam: one key's work, queued as the controller queues it. */
export function queueLiveWorkForTest(
  key: string,
  task: () => Promise<void>
): void {
  queue(key, task)
}

/** Test seam: settles whatever the events set going. */
export async function settleLiveWork(): Promise<void> {
  await Promise.all([...work.values()])
}

/**
 * Test seam: one event from the ingest, handled as the running controller
 * handles it, against `current`.
 */
export async function handleLiveEventForTest(
  event: LiveEvent,
  current: LiveControllerOptions
): Promise<void> {
  await handle(event, current)
}

async function handle(
  event: LiveEvent,
  current: LiveControllerOptions | undefined = options
): Promise<void> {
  if (current == null) return
  const { db } = current

  if (event.type === 'status') {
    const at = lastStatusWrite.get(event.key) ?? 0
    const now = Date.now()
    // Every tick of every stream would be a write a second for a whole game.
    // A stale snapshot is only ever two seconds stale, which is well inside
    // how long a person takes to read it.
    if (now - at < STATUS_WRITE_MS) return
    lastStatusWrite.set(event.key, now)
    await writeStatus(db, event.status)
    return
  }

  if (event.type === 'rejected') {
    // Why a stream was turned away, written where the person holding the
    // encoder can see it. From their end every refusal looks the same — the
    // connection simply drops — so this is the only place the reason exists.
    if (event.key === '') return
    await db
      .updateTable('live_streams')
      .set({ last_error: event.reason, updated_at: new Date() })
      .where('key_hash', '=', hashToken(event.key))
      .execute()
    return
  }

  if (event.type === 'publishStarted') {
    await beganPublishing(current, event.liveStreamId)
    return
  }
  if (event.type === 'publisherPlaced') {
    await placeByFrameWall(db, event.liveStreamId, event.startedAt)
    return
  }
  await stoppedPublishing(current, event.liveStreamId, event.reason)
}

async function writeStatus(
  db: Kysely<Database>,
  status: LiveStatus
): Promise<void> {
  const now = new Date()
  await db
    .updateTable('live_streams')
    .set({
      status,
      status_at: now,
      // Moved every time video is arriving, not only when a publish starts and
      // stops. It is what "this stream has been silent for ten minutes" is
      // measured from, and a stamp that never moved meant any game longer than
      // ten minutes looked silent the moment anything else made the row read
      // `idle` — a restart, most of all. The recording was then closed under a
      // game that was still being played.
      ...(status.ingress.publishing ? { last_published_at: now } : {})
    })
    .where('id', '=', status.liveStreamId)
    .execute()
}

/**
 * Video has started arriving.
 *
 * The video the stream writes into already exists — it is made with the key,
 * because the ingest has to know the directory before anything connects — so
 * this is the moment it stops being a placeholder and becomes something people
 * can watch.
 */
export async function beganPublishing(
  current: LiveControllerOptions,
  liveStreamId: string
): Promise<void> {
  const generation = originGeneration
  const { db } = current
  const now = new Date()
  publisherActivity.set(liveStreamId, now)
  const row = await db
    .selectFrom('live_streams')
    .select([
      'video_id as videoId',
      'first_published_at as firstPublishedAt',
      'user_id as userId',
      'game_id as gameId',
      'team_id as teamId'
    ])
    .where('id', '=', liveStreamId)
    .executeTakeFirst()
  if (row == null) return
  if (!(await mayPublish(db, row))) {
    await revokePublishing(db, liveStreamId, now)
    return
  }

  // The stream and its video go live together, and home and the game's
  // event hear of it from this transaction's last statements.
  const began = await atomic(db, async trx => {
    const updated = await trx
      .updateTable('live_streams')
      .set({
        state: 'publishing',
        first_published_at: row.firstPublishedAt ?? now,
        last_published_at: now,
        last_error: null,
        updated_at: now
      })
      .where('id', '=', liveStreamId)
      .where('state', 'in', ['idle', 'publishing'])
      .executeTakeFirst()

    if (updated.numUpdatedRows === 0n) return
    // Its video is live, and counts on its season's row from now.
    await noteGameFigures(trx, row.gameId)
    if (row.videoId == null) return
    await trx
      .updateTable('videos')
      .set(eb => ({
        status: 'live',
        hidden: false,
        // A reconnect keeps the first start: the video is one recording of
        // one game, and its clock began when the first frame did. So does a
        // start its publisher has already given (`placeByPublisher`), which
        // can land before this does.
        start_at: eb.fn.coalesce('start_at', eb.val(now)),
        start_at_source: eb.fn.coalesce(
          'start_at_source',
          eb.val<'liveSession'>('liveSession')
        ),
        updated_at: now
      }))
      .where('id', '=', row.videoId)
      .execute()
    return true
  })
  if (
    began === true &&
    row.videoId != null &&
    generation === originGeneration
  ) {
    const origin = startOrigin(current, row.videoId, liveStreamId)
    if (origin != null) queueOrigin(row.videoId, origin)
  }
}

/**
 * The stream has gone.
 *
 * It may be back: an encoder at a ball field drops out for twenty seconds at a
 * time, and the key stays open for hours. So this closes the *state*, not the
 * video — the video is finished when its window closes or somebody ends it,
 * which is [finishStream].
 */
async function stoppedPublishing(
  current: LiveControllerOptions,
  liveStreamId: string,
  reason: string
): Promise<void> {
  const { db, mediaRoot } = current
  const now = new Date()
  publisherActivity.set(liveStreamId, now)
  const row = await db
    .selectFrom('live_streams')
    .select(['video_id as videoId', 'game_id as gameId'])
    .where('id', '=', liveStreamId)
    .executeTakeFirst()
  // Looked at before the transaction, so it holds no row across the disk.
  const empty =
    row?.videoId != null && !(await hasMedia(mediaRoot, row.videoId))

  await atomic(db, async trx => {
    const stopped = await trx
      .updateTable('live_streams')
      .set({
        state: 'idle',
        last_published_at: now,
        last_error: reason,
        updated_at: now
      })
      .where('id', '=', liveStreamId)
      .where('state', '=', 'publishing')
      .executeTakeFirst()
    if (row == null) return
    if (stopped.numUpdatedRows > 0n)
      noteScopeChange(trx, { gameId: row.gameId })

    // A publish that was turned away — the wrong codec, usually — leaves a
    // video row that was made visible the moment it connected and holds no
    // video at all. It goes back to being a placeholder, rather than sitting
    // on the home screen as a live game nobody can watch.
    if (row.videoId == null || !empty) return
    const hidden = await trx
      .updateTable('videos')
      .set({ status: 'processing', hidden: true, updated_at: now })
      .where('id', '=', row.videoId)
      .where('status', '=', 'live')
      .executeTakeFirst()
    if (hidden.numUpdatedRows > 0n) await noteGameFigures(trx, row.gameId)
  })
}

/** Whether anything was ever written for this video. */
async function hasMedia(mediaRoot: string, videoId: string): Promise<boolean> {
  try {
    await stat(join(liveVideoDir(mediaRoot, videoId), LIVE_PLAYLIST_NAME))
    return true
  } catch {
    return false
  }
}

/**
 * One key, looked up the moment somebody tries to use it.
 *
 * The timer below keeps the ingest's set of keys current, but a stream created
 * seconds ago is not in it yet — and that is exactly when a URL gets used,
 * because the person was just handed it. So a key the ingest does not know is
 * checked against the database once, rather than refused.
 *
 * The check is the same one the timer makes: the key exists, it has not been
 * revoked or finished, and now is inside its window.
 */
export async function resolveKey(
  key: string,
  /** The running controller's, except in a test that has its own. */
  current: LiveControllerOptions | undefined = options
): Promise<LiveSpec | string | undefined> {
  if (current == null) return undefined
  const { db, mediaRoot } = current
  const now = new Date()
  const revision = finalizationRevision

  const row = await db
    .selectFrom('live_streams')
    .leftJoin('videos', 'videos.id', 'live_streams.video_id')
    .select([
      'live_streams.id as id',
      'live_streams.user_id as userId',
      'live_streams.team_id as teamId',
      'live_streams.game_id as gameId',
      'live_streams.state as state',
      'live_streams.opens_at as opensAt',
      'live_streams.closes_at as closesAt',
      'live_streams.video_id as videoId',
      'videos.start_at as videoStartAt'
    ])
    .where('live_streams.key_hash', '=', hashToken(key))
    // `ended` and `revoked` are looked up too, so that a key which *was* ours
    // is answered with what became of it rather than with `unknown key`.
    .executeTakeFirst()
  if (row == null) return undefined
  if (row.state === 'ended') {
    return 'This game’s stream has already finished.'
  }
  if (row.state === 'revoked') {
    return 'This key has been replaced. Ask for the game’s stream URL again.'
  }
  if (!(await mayPublish(db, row))) {
    await revokePublishing(db, row.id, now)
    return 'This account no longer has permission to stream this game.'
  }
  if (row.videoId == null) return undefined
  // A real key, at the wrong time. Saying so is the difference between an
  // operator checking their clock and an operator hunting for a key they
  // already have — and `unknown key`, which is what this used to answer, sends
  // them hunting.
  //
  // Only the closing end refuses now. A key is open from the moment it is
  // issued, so it can be tried before the day.
  // A key works before, during and after the game until somebody ends it
  // or sync finalizes it after both the quiet and scheduled-end clocks.
  if (row.closesAt != null && now >= new Date(row.closesAt)) {
    return 'This stream was ended. Ask for a new key.'
  }

  // The same floor the loop applies, because this is the door most first
  // publishes come through: a key issued a moment ago is not in the ingest's
  // hands yet, so it arrives here, and a stream let in this way would fill the
  // volume the loop was refusing to let anything fill. The sentence goes back
  // to the ingest rather than onto the row, so that what the operator reads is
  // why this was refused and not the generic `unknown key` that would land on
  // top of it a moment later.
  const room = roomToRecord(
    await (current.freeBytes ?? freeBytes)(mediaRoot),
    current.live.freeDiskFloorGb * 1_000_000_000
  )
  if (!room.ok) return room.reason ?? 'there is no room to record'

  const hlsDir = liveVideoDir(mediaRoot, row.videoId)
  await mkdir(hlsDir, { recursive: true })
  if (finalizingStreams.has(row.id))
    return 'This game’s stream has already finished.'
  // Any finish during the lookup invalidates its snapshot. Retry against the
  // database once that finish has committed; unrelated finishes are harmless.
  // No await remains between this check and handing back the specification.
  if (revision !== finalizationRevision) return await resolveKey(key, current)
  const known = tracked.get(row.id)
  if (known != null && known.key !== key)
    clearLive(known.key, 'the key was replaced')
  tracked.set(row.id, { key, videoId: row.videoId })
  return {
    liveStreamId: row.id,
    hlsDir,
    destinations: [],
    videoStartMs: millisOf(row.videoStartAt)
  }
}

/** A row's timestamp in milliseconds, or undefined when it has none. */
function millisOf(value: Date | string | null | undefined): number | undefined {
  if (value == null) return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Every second: hand the ingest the keys that may publish now, take away the
 * ones that may not, and close anything whose window has run out.
 */
export async function sync(
  /** The running controller's, except in a test that has its own. */
  current: LiveControllerOptions | undefined = options
): Promise<void> {
  if (current == null) return
  const generation = originGeneration
  const { db, mediaRoot, sessionSecret } = current
  const now = new Date()

  const rows = await db
    .selectFrom('live_streams')
    .leftJoin('videos', 'videos.id', 'live_streams.video_id')
    .leftJoin('games', 'games.id', 'live_streams.game_id')
    .select([
      'live_streams.id as id',
      'live_streams.user_id as userId',
      'live_streams.team_id as teamId',
      'live_streams.game_id as gameId',
      'live_streams.key_cipher as keyCipher',
      'live_streams.state as state',
      'live_streams.opens_at as opensAt',
      'live_streams.closes_at as closesAt',
      'live_streams.video_id as videoId',
      'live_streams.last_published_at as lastPublishedAt',
      'live_streams.last_error as lastError',
      'live_streams.local_recording as localRecording',
      'games.end_at as gameEndAt',
      'videos.start_at as videoStartAt'
    ])
    .where(eb =>
      eb.or([
        eb('live_streams.state', 'in', ['idle', 'publishing']),
        eb.and([
          eb('live_streams.state', '=', 'revoked'),
          eb('live_streams.ended_at', 'is', null)
        ])
      ])
    )
    // In a fixed order, so one tick goes through the streams as the last did.
    .orderBy('live_streams.id')
    .execute()

  // One syscall a second, and only asked at all when there is something that
  // might want to start.
  const measure = current.freeBytes ?? freeBytes
  const room =
    rows.length === 0
      ? { ok: true }
      : roomToRecord(
          await measure(mediaRoot),
          current.live.freeDiskFloorGb * 1_000_000_000
        )

  const wanted = new Set<string>()
  // Streams being finished, side by side rather than one after another: each
  // waits for its own writer to exit, and angles ended together should not
  // hold up every other stream's tick for the sum of those waits.
  //
  // Each is caught the moment it starts, and what it threw is kept: one that
  // fails while a later row is still being looked at would otherwise be a
  // rejection nobody is waiting on yet, and Node ends the whole server for
  // that.
  const finishing: Array<Promise<{ error: unknown } | undefined>> = []
  const finish = (liveStreamId: string, reason: string): void => {
    finishing.push(
      finishStream(current, liveStreamId, reason, generation).then(
        () => undefined,
        (error: unknown) => ({ error })
      )
    )
  }
  let failure: { error: unknown } | undefined
  try {
    for (const row of rows) {
      if (row.state === 'revoked') {
        finish(
          row.id,
          row.localRecording === 'uploaded'
            ? REPLACED_BY_UPLOAD
            : (row.lastError ?? 'streaming permission was removed')
        )
        continue
      }
      if (!(await mayPublish(db, row))) {
        await revokePublishing(db, row.id, now)
        finish(row.id, 'streaming permission was removed')
        continue
      }
      // `closes_at` is now the moment somebody ended it rather than a window
      // shutting on its own, so this is what End stream, a rotation and a
      // removal all come through.
      const closesAt = row.closesAt == null ? null : new Date(row.closesAt)
      if (closesAt != null && now >= closesAt) {
        finish(row.id, 'the stream was ended')
        continue
      }
      // A reconnect can start AND stop while the snapshot's permission or
      // disk checks await. Completed events reset the quiet clock in memory;
      // queued events and active ingest veto expiry before their writes land.
      const activity = publisherActivity.get(row.id)
      const quietRow =
        activity == null
          ? row
          : {
              ...row,
              lastPublishedAt: new Date(
                Math.max(
                  activity.getTime(),
                  millisOf(row.lastPublishedAt ?? row.opensAt) ?? 0
                )
              )
            }
      if (quietStreamCanEnd(quietRow, now)) {
        const key = tracked.get(row.id)?.key
        if (
          key == null ||
          (!work.has(key) && statusFor(key)?.ingress.publishing !== true)
        ) {
          finish(row.id, 'the stream was quiet after the scheduled game end')
          continue
        }
      }
      if (row.videoId == null) continue
      await closeAfterGrace(current, row, now)

      // A stream already running is left alone: cutting a game off part way
      // through is worse than letting it use the last of the disk, and ffmpeg
      // will say so itself if it truly runs out.
      if (!room.ok && row.state !== 'publishing') {
        await sayOnce(db, row.id, row.lastError, room.reason ?? null, now)
        continue
      }

      let key: string
      try {
        key = openSecret(sessionSecret, row.keyCipher)
      } catch {
        // The server's secret changed under a key that was already issued. Say
        // so on the row rather than leaving a stream that can never be used.
        await sayOnce(
          db,
          row.id,
          row.lastError,
          'This key cannot be read any more. Rotate it.',
          now
        )
        continue
      }

      // A key that has been rotated is a key somebody wanted stopped — that is
      // the whole point of rotating one — so the old key goes now, taking any
      // stream publishing with it, rather than lasting until the game ends. The
      // sweep below cannot do it: this row's entry is about to be overwritten
      // with the new key, and the old one would never be looked at again.
      const known = tracked.get(row.id)
      if (known != null && known.key !== key) {
        clearLive(known.key, 'the key was replaced')
      }

      const hlsDir = liveVideoDir(mediaRoot, row.videoId)
      await mkdir(hlsDir, { recursive: true })
      setLive(key, {
        liveStreamId: row.id,
        hlsDir,
        destinations: [],
        videoStartMs: millisOf(row.videoStartAt)
      })
      tracked.set(row.id, { key, videoId: row.videoId })
      wanted.add(key)
      await recordWallPoints(current, row.videoId, hlsDir)
    }

    // Anything the ingest still holds that this pass did not ask for: a revoked
    // key, a rotated one, a window that closed.
    for (const [liveStreamId, entry] of tracked) {
      if (wanted.has(entry.key)) continue
      clearLive(entry.key, 'no longer open')
      tracked.delete(liveStreamId)
    }
  } catch (error) {
    failure = { error }
  }

  // Every finish runs to its end before the tick does, even a tick that
  // failed part way, so nothing it started is left running unwatched. The
  // tick's own failure is the one it reports, and otherwise the first
  // finish's, as it was when they ran in turn.
  const finished = await Promise.all(finishing)
  failure ??= finished.find(one => one != null)
  if (generation === originGeneration) {
    for (const [videoId, origin] of origins) queueOrigin(videoId, origin)
  }
  if (failure != null) throw failure.error
}

/**
 * Closes the playlist of a stream whose publisher has been away for longer
 * than `RECONNECT_GRACE_MS`, once per absence.
 *
 * Measured from `last_published_at`, which moves while video arrives and is
 * stamped when the publisher goes, so it holds across a restart of this
 * process too. A stream the ingest says is publishing again is left alone
 * whatever the row says: the row learns of a reconnect a moment after the
 * ingest does, and closing the playlist then would put an `ENDLIST` under a
 * writer that has just started appending to it.
 */
async function closeAfterGrace(
  current: LiveControllerOptions,
  row: {
    id: string
    state: string
    videoId: string | null
    lastPublishedAt: Date | string | null
  },
  now: Date
): Promise<void> {
  if (row.state !== 'idle' || row.lastPublishedAt == null) {
    closedAfterGrace.delete(row.id)
    return
  }
  const leftAt = new Date(row.lastPublishedAt).getTime()
  if (now.getTime() - leftAt <= RECONNECT_GRACE_MS) return
  if (closedAfterGrace.get(row.id) === leftAt) return
  const key = tracked.get(row.id)?.key
  const away = (): boolean =>
    key == null || statusFor(key)?.ingress.publishing !== true
  if (!away()) return
  if (row.videoId == null) return
  closedAfterGrace.set(row.id, leftAt)
  await closePlaylist(current.mediaRoot, row.videoId, away)
}

/**
 * Adds the wall-clock points of the segments the stream has written since the
 * last tick.
 *
 * Idle streams too, not only publishing ones: the writer finishes the last
 * segment of a publish after the publisher has gone, and a segment found only
 * after the reconnect would be placed by an arrival twenty seconds late. A
 * failure is said and tried again on the next tick, from the same place,
 * rather than stopping the loop that keeps every other stream going; but a
 * segment that cannot be read as video is said once and passed over, as
 * trying it again would only fail again (`scanNewSegments`). A stream
 * this server has no cursor for, as after a restart, carries on after the
 * points already stored (`resumeScan`), and one look reads a few segments at
 * most (`SEGMENTS_PER_SCAN`), so neither a long stream nor a backlog holds the
 * tick up. The scan reads the clock itself, once it has read the playlist:
 * the tick's own `now` comes before its database and disk work, which can
 * take seconds on a busy machine.
 */
async function recordWallPoints(
  current: LiveControllerOptions,
  videoId: string,
  hlsDir: string
): Promise<void> {
  const say = current.log ?? console.log
  try {
    const cursor =
      anchorCursors.get(videoId) ??
      (await resumeScan(current.db, videoId, hlsDir))
    const scanned = await scanNewSegments(hlsDir, cursor)
    await storeWallPoints(current.db, videoId, scanned.points)
    anchorCursors.set(videoId, scanned.cursor)
    for (const problem of scanned.unreadable)
      say(`live: wall clock of ${videoId}: passed over ${problem}`)
  } catch (error) {
    say(`live: wall clock of ${videoId}: ${String(error)}`)
  }
}

/** A key belongs to an active account filming a current side of this game. */
async function mayPublish(
  db: Kysely<Database>,
  row: { userId: string; gameId: string; teamId: string }
): Promise<boolean> {
  const user = await db
    .selectFrom('users')
    .select(['is_admin', 'disabled_at', 'merged_into', 'login_enabled'])
    .where('id', '=', row.userId)
    .executeTakeFirst()
  if (
    user == null ||
    user.disabled_at != null ||
    user.merged_into != null ||
    !user.login_enabled
  )
    return false
  const game = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id'])
    .where('id', '=', row.gameId)
    .executeTakeFirst()
  if (
    game == null ||
    ![game.home_team_id, game.away_team_id].includes(row.teamId)
  )
    return false
  return canFilm(await roleScopes(db, row.userId, user.is_admin), row.teamId)
}

/** Lost authority permanently invalidates the old key, even if later restored. */
async function revokePublishing(
  db: Kysely<Database>,
  id: string,
  now: Date
): Promise<void> {
  const known = tracked.get(id)
  if (known != null) {
    clearLive(known.key, 'streaming permission was removed')
    tracked.delete(id)
  }
  await db
    .updateTable('live_streams')
    .set({
      state: 'revoked',
      closes_at: now,
      updated_at: now,
      last_error: 'Streaming permission was removed. Ask for a new stream URL.'
    })
    .where('id', '=', id)
    .where('state', 'in', ['idle', 'publishing'])
    .execute()
}

/**
 * Writes a reason on a stream's row, but only when it is news.
 *
 * This loop runs every second, and a condition it reports — no disk, a key it
 * cannot read — lasts until somebody does something about it. Writing the same
 * sentence eighty-six thousand times a day would say nothing new and would
 * move `updated_at` every second of it.
 */
async function sayOnce(
  db: Kysely<Database>,
  liveStreamId: string,
  current: string | null,
  reason: string | null,
  now: Date
): Promise<void> {
  if (current === reason) return
  await db
    .updateTable('live_streams')
    .set({ last_error: reason, updated_at: now })
    .where('id', '=', liveStreamId)
    .execute()
}

/**
 * Ends a stream for good: the key stops working, the playlist is closed, and
 * the video becomes an ordinary recording of the game.
 */
export async function finishStream(
  current: LiveControllerOptions,
  liveStreamId: string,
  reason: string,
  generation = originGeneration
): Promise<void> {
  finalizationRevision++
  finalizingStreams.set(
    liveStreamId,
    (finalizingStreams.get(liveStreamId) ?? 0) + 1
  )
  try {
    await finishStreamRecording(current, liveStreamId, reason, generation)
  } finally {
    // A lookup can begin after the start revision but read before the commit.
    finalizationRevision++
    const remaining = finalizingStreams.get(liveStreamId)! - 1
    if (remaining === 0) finalizingStreams.delete(liveStreamId)
    else finalizingStreams.set(liveStreamId, remaining)
  }
}

async function finishStreamRecording(
  current: LiveControllerOptions,
  liveStreamId: string,
  reason: string,
  generation: number
): Promise<void> {
  const { db, mediaRoot, ffmpegPath } = current
  const entry = tracked.get(liveStreamId)
  publisherActivity.delete(liveStreamId)
  closedAfterGrace.delete(liveStreamId)
  if (entry != null) {
    tracked.delete(liveStreamId)
    // The writer's last segment and its last playlist land before the
    // playlist is closed below, not on top of it.
    await clearLiveSettled(entry.key, reason)
  }

  const now = new Date()
  // Claim finalization once. A revoked key remains revoked while its recording
  // follows the same retained-media lifecycle as an ordinarily ended stream.
  const row = await atomic(db, async trx => {
    const claimed = await trx
      .updateTable('live_streams')
      .set({
        state: sql`case when state = 'revoked' then 'revoked' else 'ended' end`,
        ended_at: now,
        last_error: reason,
        updated_at: now
      })
      .where('id', '=', liveStreamId)
      .where('state', 'in', ['idle', 'publishing', 'revoked'])
      .where('ended_at', 'is', null)
      .returning([
        'video_id as videoId',
        'first_published_at as firstPublishedAt',
        'game_id as gameId'
      ])
      .executeTakeFirst()
    if (claimed != null) await noteGameFigures(trx, claimed.gameId)
    return claimed
  })

  if (row?.videoId == null) return
  const { gameId } = row
  // Each way the video ends is one write and the clock, in one transaction.
  // The disk is read between them, outside any.
  const settle = async (
    write: (trx: Kysely<Database>) => Promise<unknown>
  ): Promise<void> => {
    await atomic(db, async trx => {
      await write(trx)
      // A finished video counts on its season's row.
      await noteGameFigures(trx, gameId)
    })
  }

  // A key nobody ever used, or used only by something that was turned away —
  // an encoder in the wrong codec connects and is refused, which does count as
  // having published — leaves nothing behind. Deleting the placeholder is what
  // keeps "we gave this game a stream URL once" from showing up in the game's
  // videos for ever as a recording that does not exist.
  if (
    row.firstPublishedAt == null ||
    !(await hasMedia(mediaRoot, row.videoId))
  ) {
    const videoId = row.videoId
    anchorCursors.delete(videoId)
    origins.get(videoId)?.publisher.stop()
    await settle(
      async trx =>
        await trx.deleteFrom('videos').where('id', '=', videoId).execute()
    )
    queue(`publish:${videoId}`, async () => {
      await removeDeletedOrigin(current, videoId)
    })
    return
  }

  await closePlaylist(mediaRoot, row.videoId)
  const dir = liveVideoDir(mediaRoot, row.videoId)
  const durationSec = await probeDuration(
    ffprobeFor(ffmpegPath),
    join(dir, LIVE_PLAYLIST_NAME)
  ).catch(() => null)

  if (durationSec == null) {
    const videoId = row.videoId
    anchorCursors.delete(videoId)
    stopOrigin(videoId)
    await settle(
      async trx =>
        await trx
          .updateTable('videos')
          .set({
            status: 'error',
            status_message: 'The finished stream could not be read',
            published_at: now,
            updated_at: now
          })
          .where('id', '=', videoId)
          .execute()
    )
    return
  }

  // A sound track stamped away from the picture it arrived with plays out of
  // step for the whole recording. The video is still ready — the picture is
  // whole — but the row and the log say so.
  const soundProblem = soundStepProblem(
    await checkTrackStarts(join(dir, LIVE_PLAYLIST_NAME)).catch(() => undefined)
  )
  if (soundProblem != null) {
    ;(current.log ?? console.log)(`live: ${row.videoId}: ${soundProblem}`)
  }

  // Watchable at once, from this machine, while the rest happens.
  const finished = row.videoId
  await settle(
    async trx =>
      await trx
        .updateTable('videos')
        .set({
          status: 'ready',
          status_message: soundProblem ?? null,
          duration_sec: durationSec,
          published_at: now,
          updated_at: now
        })
        .where('id', '=', finished)
        .execute()
  )

  queueOriginClose(current, row.videoId, liveStreamId, generation)
}

/** Finish work shares the publisher queue, behind any first-segment callback. */
function queueOriginClose(
  current: LiveControllerOptions,
  videoId: string,
  liveStreamId: string,
  generation: number
): void {
  if (generation !== originGeneration) return
  const held = origins.get(videoId)
  if (held != null) held.publisher.closing = true
  queue(`publish:${videoId}`, async () => {
    if (generation !== originGeneration) return
    const row = await current.db
      .selectFrom('videos')
      .select(['storage', 'replaced_by', 'spaces_verified_at', 'duration_sec'])
      .where('id', '=', videoId)
      .executeTakeFirst()
    // Shutdown may have stopped and removed this publisher during the lookup.
    if (generation !== originGeneration) return
    if (row == null) {
      await removeDeletedOrigin(current, videoId)
      return
    }
    if (row.storage === 'spaces') {
      if (row.spaces_verified_at == null)
        await closeOrigin(current, videoId, liveStreamId, row.duration_sec ?? 0)
      return
    }
    stopOrigin(videoId)
    anchorCursors.delete(videoId)
    if (row.replaced_by == null) await putAway(current, videoId)
  })
}

async function removeDeletedOrigin(
  current: LiveControllerOptions,
  videoId: string
): Promise<void> {
  // Stop writing now, but keep the origin discoverable by sync until both
  // cleanup operations succeed. The deleted database row cannot drive retries.
  origins.get(videoId)?.publisher.stop()
  await rm(liveVideoDir(current.mediaRoot, videoId), {
    recursive: true,
    force: true
  })
  if (current.space != null && spaceConfigured(current.space))
    await deleteVideoFromSpace({ space: current.space, videoId })
  stopOrigin(videoId)
  anchorCursors.delete(videoId)
}

async function closeOrigin(
  current: LiveControllerOptions,
  videoId: string,
  liveStreamId: string,
  durationSec: number
): Promise<void> {
  const { db, space } = current
  const dir = liveVideoDir(current.mediaRoot, videoId)
  try {
    const origin = startOrigin(current, videoId, liveStreamId)
    if (origin == null || space == null)
      throw new Error('No Space configured for live recording')
    origin.publisher.closing = true
    await closePlaylist(current.mediaRoot, videoId)
    // Each pass stays bounded. A failed scan advances nothing and ends the drain.
    for (;;) {
      const before = anchorCursors.get(videoId)?.segments ?? -1
      await recordWallPoints(current, videoId, dir)
      const after = anchorCursors.get(videoId)?.segments ?? -1
      if (after <= before) break
    }
    await replaceAnchorsFromRecording(db, videoId, dir, LIVE_PLAYLIST_NAME)
    anchorCursors.delete(videoId)
    origin.refreshFinal()
    const result = await origin.publisher.flush({ close: true })
    if (!result.complete || result.body == null)
      throw new Error('Live origin is not fully acknowledged')
    const response = await fetch(
      presignGetUrl({
        ...space,
        key: `videos/${videoId}/index.m3u8`,
        expiresSec: 300
      })
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Closed playlist answered ${response.status}`)
    }
    if ((await response.text()) !== result.body)
      throw new Error('Closed playlist came back different')
    await keepAPicture(current, videoId, dir, durationSec, LIVE_PLAYLIST_NAME)
    const row = await db
      .selectFrom('videos')
      .select('status_message')
      .where('id', '=', videoId)
      .executeTakeFirst()
    if (row == null) {
      await removeDeletedOrigin(current, videoId)
      return
    }
    const now = new Date()
    await db
      .updateTable('videos')
      .set({
        spaces_verified_at: now,
        local_delete_after: now,
        status_message: isSoundStepProblem(row.status_message)
          ? row.status_message
          : null,
        updated_at: now
      })
      .where('id', '=', videoId)
      .execute()
    // The durable cleanup marker survives a crash or a failed removal.
    stopOrigin(videoId)
    await rm(dir, { recursive: true, force: true })
    await db
      .updateTable('videos')
      .set({ local_delete_after: null })
      .where('id', '=', videoId)
      .execute()
  } catch (error) {
    ;(current.log ?? console.log)(
      `live: ${videoId} close failed: ${String(error)}`
    )
    await db
      .updateTable('videos')
      .set({
        status_message: 'Not yet copied off this machine',
        updated_at: new Date()
      })
      .where('id', '=', videoId)
      .where('spaces_verified_at', 'is', null)
      .execute()
  }
}

async function retryTheClose(
  current: LiveControllerOptions,
  generation: number
): Promise<void> {
  if (generation !== originGeneration) return
  const rows = await current.db
    .selectFrom('videos')
    .leftJoin('live_streams', 'live_streams.video_id', 'videos.id')
    .select(['videos.id', 'live_streams.id as streamId'])
    .where('videos.kind', '=', 'live')
    .where('videos.status', '=', 'ready')
    .where('videos.storage', '=', 'spaces')
    .where('videos.spaces_verified_at', 'is', null)
    .where('videos.updated_at', '<', new Date(Date.now() - RETRY_AFTER_MS))
    .orderBy('videos.updated_at', 'asc')
    .limit(5)
    .execute()
  for (const row of rows)
    queueOriginClose(current, row.id, row.streamId ?? '', generation)
}

/**
 * The end of a recording's life as a live stream: one file instead of two
 * thousand, then the Space, then the local copy goes.
 *
 * Deliberately after the video has been marked `ready`, and deliberately
 * off the path that ends the stream: a game that has just finished is a game
 * somebody is about to watch, and they should not wait on a remux and an
 * upload to do it.
 */
async function putAway(
  current: LiveControllerOptions,
  videoId: string
): Promise<void> {
  const { db, ffmpegPath, mediaRoot, space } = current
  const log =
    current.log ??
    ((message: string) => {
      console.log(message)
    })
  const dir = liveVideoDir(mediaRoot, videoId)

  // Already packed up: this is a second attempt, because the Space could not
  // be reached the first time. The remux is not repeated — it is the same
  // recording, and doing it again would rewrite the file somebody may be
  // watching.
  if (await isRecordingShape(dir)) {
    await toTheSpace(current, videoId, dir, RECORDING_FILES)
    return
  }

  let recording
  try {
    recording = await toRecording(ffmpegPath, dir)
  } catch (error) {
    // The segments are still there and still play. Saying so on the row beats
    // a video that silently never becomes ordinary.
    log(`live: could not remux ${videoId}: ${String(error)}`)
    await db
      .updateTable('videos')
      .set({
        status_message: COULD_NOT_PACK,
        updated_at: new Date()
      })
      .where('id', '=', videoId)
      .execute()
    return
  }

  // The recording's own timeline, which is where the points belong now.
  try {
    await replaceAnchorsFromRecording(db, videoId, dir)
  } catch (error) {
    log(`live: wall clock of ${videoId} not rescanned: ${String(error)}`)
  }

  await db
    .updateTable('videos')
    .set({
      duration_sec: recording.durationSec,
      width: recording.width ?? null,
      height: recording.height ?? null,
      codecs: recording.codecTag,
      updated_at: new Date()
    })
    .where('id', '=', videoId)
    .execute()

  await keepAPicture(current, videoId, dir, recording.durationSec)

  if (space == null || !spaceConfigured(space)) {
    // Development, or a Space not configured yet. The recording stays here and
    // is served from here, which is a working answer rather than a broken one.
    log(`live: ${videoId} packed up; no Space configured, keeping it local`)
    return
  }

  await toTheSpace(current, videoId, dir, recording.files)
}

/**
 * Cuts the frame a list will ask for, while the file is still here.
 *
 * A still can be had from the Space afterwards, so this is no longer the only
 * chance at one. It is still the cheap chance: the file is on this disk for
 * another six hours, and one local seek now saves the first person to open a
 * list from waiting on a fragment coming back over the network.
 */
async function keepAPicture(
  current: LiveControllerOptions,
  videoId: string,
  dir: string,
  durationSec: number,
  sourceFile: string = VIDEO_FILE
): Promise<void> {
  try {
    if (current.space == null) return
    await ensureStill({
      ffmpegPath: current.ffmpegPath,
      source: { kind: 'file', path: join(dir, sourceFile) },
      space: current.space,
      videoId,
      atSec: posterSecond(durationSec)
    })
  } catch {
    // A missing thumbnail is a plate, not a failure worth reporting. The
    // recording itself is what matters here and it is already written.
  }
}

/** What a packed-up recording is made of. */
const RECORDING_FILES = ['master.m3u8', 'video.m3u8', 'video.mp4']

/**
 * Copies a finished recording to the Space, and only says so once the Space
 * agrees it has it.
 *
 * A failure here is not final: the recording is still on this machine and
 * still plays, the row says why it has not gone yet, and the sweep tries again
 * on its next round. The alternative — giving up quietly — leaves a game on a
 * disk that is being cleared to make room for the next one.
 */
async function toTheSpace(
  current: LiveControllerOptions,
  videoId: string,
  dir: string,
  files: string[]
): Promise<void> {
  const { db, space } = current
  const log =
    current.log ??
    ((message: string) => {
      console.log(message)
    })
  if (space == null || !spaceConfigured(space)) return

  try {
    const uploaded = await uploadVideoDirectory({ space, videoId, dir, files })
    const verified = await verifyVideoDirectory({
      space,
      videoId,
      dir,
      files: uploaded.files
    })
    if (!verified.ok) {
      log(`live: ${videoId} did not verify in the Space: ${verified.reason}`)
      await db
        .updateTable('videos')
        .set({
          status_message: `Not yet copied off this machine: ${verified.reason}`,
          updated_at: new Date()
        })
        .where('id', '=', videoId)
        .execute()
      return
    }

    // What the finished stream's check said about its sound stays on the row.
    // It cannot be found again in the recording: a remux of sound stamped from
    // 0 s puts it at the start, where it looks like any other.
    const before = await db
      .selectFrom('videos')
      .select('status_message as message')
      .where('id', '=', videoId)
      .executeTakeFirst()
    const soundProblem = isSoundStepProblem(before?.message)
      ? before?.message
      : null
    const now = new Date()
    await db
      .updateTable('videos')
      .set({
        storage: 'spaces',
        status_message: soundProblem ?? null,
        spaces_verified_at: now,
        // The grace is for playback tokens already in somebody's player, which
        // point at this machine. They last six hours; so does the copy.
        local_delete_after: new Date(now.getTime() + LOCAL_GRACE_MS),
        updated_at: now
      })
      .where('id', '=', videoId)
      .execute()
    log(
      `live: ${videoId} is in the Space (${uploaded.files.length} files, ` +
        `${uploaded.bytes} bytes), local copy goes in six hours`
    )
  } catch (error) {
    log(`live: ${videoId} could not be copied to the Space: ${String(error)}`)
    await db
      .updateTable('videos')
      .set({
        status_message: 'Not yet copied off this machine',
        updated_at: new Date()
      })
      .where('id', '=', videoId)
      .execute()
  }
}

/**
 * Writes `EXT-X-ENDLIST`, once.
 *
 * The writer never does (`omit_endlist`): a publisher going away is not the
 * end of the game. This is, at the end of a stream and past the reconnect
 * grace. A playlist without it keeps every player waiting for a segment that
 * is never coming, and the video is unseekable to its own end.
 */
async function closePlaylist(
  mediaRoot: string,
  videoId: string,
  /**
   * Whether the publisher is still away. Asked again at the last moment,
   * when it may have come back while the playlist was being read.
   */
  stillAway: () => boolean = () => true
): Promise<void> {
  const path = join(liveVideoDir(mediaRoot, videoId), LIVE_PLAYLIST_NAME)
  let playlist: string
  try {
    playlist = await readFile(path, 'utf8')
  } catch {
    return
  }
  if (playlist.includes('#EXT-X-ENDLIST')) return
  // The last look, the read and the write happen together, with nothing
  // awaited between them. A publisher coming back reopens the playlist the
  // same way (`reopenPlaylist`), so it either came back before this, which
  // the look sees, or comes back after, and finds an `ENDLIST` to take off.
  // An awaited write here could land after the new writer had started
  // appending, and put the `ENDLIST` back under it.
  if (!stillAway()) return
  try {
    playlist = readFileSync(path, 'utf8')
  } catch {
    return
  }
  if (playlist.includes('#EXT-X-ENDLIST')) return
  const ended = playlist.endsWith('\n')
    ? `${playlist}#EXT-X-ENDLIST\n`
    : `${playlist}\n#EXT-X-ENDLIST\n`
  writeFileSync(path, ended)
}
