import { randomBytes } from 'crypto'
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely'

import { badRequest, conflict, gone } from '../../common/errors'
import { makeId } from '../../common/ids'
import { rtmpOrigin } from '../../common/primaryUrl'
import { hashToken } from '../auth/tokens'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import type { LiveSettings } from '../serverConfig'
import { openSecret, sealSecret } from './secrets'

/**
 * The key in a stream URL, and where that URL points.
 *
 * The key carries no meaning: it is not the game's id wearing a hat, because
 * anything readable in a key is something an onlooker learns from a URL on a
 * screen at a ballpark. It is 128 random bits, prefixed so that a key found in
 * a log is recognisably ours.
 */
export function makeStreamKey(): string {
  return `ts_${randomBytes(16).toString('base64url')}`
}

/**
 * `rtmp://host:port` with no trailing slash and no path.
 *
 * `host` is what the deployment calls itself, never `bindHost`: the ingest
 * binds `0.0.0.0`, which is not an address anybody can publish to, and the
 * name an encoder reaches this machine by is the same name a browser reaches
 * it by. `rtmp` and not `rtmps` wherever it points — there is no encrypted
 * RTMP here to choose between.
 */
export function liveBaseUrl(live: LiveSettings, host: string): string {
  return rtmpOrigin(host, live.port)
}

/** The whole thing, key and all — what gets pasted into streaming software. */
export function streamUrlFor(
  live: LiveSettings,
  host: string,
  key: string
): string {
  return `${liveBaseUrl(live, host)}/${live.app}/${key}`
}

export interface NewStreamKey {
  key: string
  keyHash: string
  keyPrefix: string
  keyCipher: string
}

export function newStreamKey(sessionSecret: string): NewStreamKey {
  const key = makeStreamKey()
  return {
    key,
    keyHash: hashToken(key),
    // Enough to tell two keys apart in a list, far too little to publish with.
    keyPrefix: key.slice(0, 9),
    keyCipher: sealSecret(sessionSecret, key)
  }
}

/**
 * The publish window, which has no clock at either end.
 *
 * It used to open two hours before the first pitch and shut six hours after
 * it, and both bounds got in the way of the only thing anybody does first:
 * try the URL. Somebody setting up for Saturday points a camera at the ingest
 * on Thursday; somebody proving the whole path works — key, ingest, packing,
 * playback — does it against a game that finished last week rather than
 * waiting for a fixture. Both were answered with a refusal that reads like a
 * broken server.
 *
 * So a key is open from the moment it exists and stops when **somebody stops
 * it**: End stream, a new key, or removing the camera. `closesAt` is null
 * until one of those happens, and then it records which moment it was.
 */
export function streamWindow(
  _live: LiveSettings,
  _startAt: Date,
  issuedAt: Date = new Date()
): { opensAt: Date; closesAt: Date | null } {
  return { opensAt: issuedAt, closesAt: null }
}

export interface LiveStreamRow {
  id: string
  gameId: string
  teamId: string
  /** Whose key it is. A key publishes video as somebody. */
  userId: number
  /** Which of that person's four cameras for this game. */
  slot: number
  /** What the camera is called. */
  label: string | null
  keyCipher: string
  keyPrefix: string
  state: 'idle' | 'publishing' | 'ended' | 'revoked'
  opensAt: Date
  /** When somebody ended it. Null while it is still good. */
  closesAt: Date | null
  videoId: string | null
  lastError: string | null
  /** The install that holds it. Null for a browser or streaming software. */
  deviceId: string | null
  /** What that device is, in words. */
  deviceModel: string | null
  /** How far the phone's own recording of it has got. */
  localRecording: 'none' | 'recorded' | 'uploaded'
  /** Only the phone's own upload replaces its live copy. */
  recordsLocally: boolean
  /** The legacy Director claim route has returned it. */
  directorClaimed: boolean
}

/** How many cameras one person may point at one game. */
export const MAX_CAMERAS = 4

/** What a camera is called when nobody has said. */
export function labelFor(row: { slot: number; label: string | null }): string {
  return row.label ?? `Camera ${row.slot}`
}

/** How long a camera name may be, counted after trimming. */
export const CAMERA_NAME_MAX = 80

/**
 * The split `angleLabels` uses. A name that contains it would show as only
 * the words after the last one.
 */
const CAMERA_NAME_SEPARATOR = ' — '

/**
 * What to store for a camera-name field.
 *
 * `undefined` means the field was absent, so a caller leaves the stored name
 * alone. `null` means it was sent and blank, which is a clear on a rename and
 * "no name" on a create. Anything else is the trimmed name.
 */
export function cameraLabelOf(
  raw: string | undefined
): string | null | undefined {
  if (raw == null) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.length > CAMERA_NAME_MAX) {
    throw badRequest('A camera name can be at most 80 characters.')
  }
  if (trimmed.includes(CAMERA_NAME_SEPARATOR)) {
    throw badRequest('A camera name cannot contain " — ".')
  }
  return trimmed
}

/** The video title with its camera-name suffix replaced, or added. */
export function titledWith(title: string, officialName: string): string {
  const at = title.lastIndexOf(CAMERA_NAME_SEPARATOR)
  const stem = at === -1 ? title : title.slice(0, at)
  return `${stem}${CAMERA_NAME_SEPARATOR}${officialName}`
}

const STREAM_FIELDS = [
  'id',
  'game_id as gameId',
  'team_id as teamId',
  'user_id as userId',
  'slot',
  'label',
  'key_cipher as keyCipher',
  'key_prefix as keyPrefix',
  'state',
  'opens_at as opensAt',
  'closes_at as closesAt',
  'video_id as videoId',
  'last_error as lastError',
  'device_id as deviceId',
  'device_model as deviceModel',
  'local_recording as localRecording',
  'records_locally as recordsLocally',
  'director_claimed as directorClaimed'
] as const

function asRow(row: {
  opensAt: Date | string
  closesAt: Date | string | null
}): LiveStreamRow {
  return {
    ...(row as unknown as LiveStreamRow),
    opensAt: new Date(row.opensAt),
    closesAt: row.closesAt == null ? null : new Date(row.closesAt)
  }
}

/**
 * Every key a game still has, whosever they are, oldest first.
 *
 * Ordered by person and then slot so a list reads as people with cameras
 * rather than as rows in whatever order the database felt like.
 */
export async function liveStreamsFor(
  db: Kysely<Database>,
  gameId: string
): Promise<LiveStreamRow[]> {
  const rows = await db
    .selectFrom('live_streams')
    .select(STREAM_FIELDS)
    .where('game_id', '=', gameId)
    .where('state', '<>', 'revoked')
    .orderBy('user_id', 'asc')
    .orderBy('slot', 'asc')
    .execute()
  return rows.map(asRow)
}

/** One person's cameras on one game. */
export async function myLiveStreams(
  db: Kysely<Database>,
  gameId: string,
  userId: number
): Promise<LiveStreamRow[]> {
  const all = await liveStreamsFor(db, gameId)
  return all.filter(row => row.userId === userId)
}

/** One key, by its id, whoever it belongs to. */
export async function liveStreamById(
  db: Kysely<Database>,
  id: string
): Promise<LiveStreamRow | undefined> {
  const row = await db
    .selectFrom('live_streams')
    .select(STREAM_FIELDS)
    .where('id', '=', id)
    .where('state', '<>', 'revoked')
    .executeTakeFirst()
  return row == null ? undefined : asRow(row)
}

/**
 * The lowest camera number this person does not already have for this game.
 *
 * Lowest rather than next, so somebody who ends their second camera and asks
 * for another gets `Camera 2` back instead of counting upwards for ever.
 */
export function freeSlot(mine: LiveStreamRow[]): number | undefined {
  for (let slot = 1; slot <= MAX_CAMERAS; slot += 1) {
    if (!mine.some(row => row.slot === slot)) return slot
  }
  return undefined
}

/** Reads a key back so it can be shown. Throws if the seal cannot be opened. */
export function revealKey(sessionSecret: string, row: LiveStreamRow): string {
  return openSecret(sessionSecret, row.keyCipher)
}

export interface CreateLiveStreamOptions {
  gameId: string
  teamId: string
  startAt: Date
  /** Whose key this is, which is also who asked for it. */
  userId: number
  /** Which of their four cameras. */
  slot: number
  /** What to call it. `Camera <slot>` where nobody has said. */
  label?: string
  live: LiveSettings
  sessionSecret: string
  /** The game, in words. The camera's name is added to it. */
  videoTitle: string
  /** The install asking, for a device stream. */
  deviceId?: string
  deviceModel?: string | null
  /** A phone that keeps its own recording of this stream. */
  recordsLocally?: boolean
  /** Made by the legacy Director claim route. */
  directorClaimed?: boolean
}

/**
 * Gives a game somewhere to stream to.
 *
 * The video row is made here rather than when the stream starts, because the
 * ingest must know where to write its HLS before anything connects, and the
 * path of a video's files is built from its id. It stays `hidden` until video
 * actually arrives, so a key nobody used never shows up as an empty recording.
 */
export async function createLiveStream(
  db: Kysely<Database>,
  options: CreateLiveStreamOptions
): Promise<LiveStreamRow & { key: string }> {
  const { gameId, teamId, startAt, userId, slot, live, sessionSecret } = options
  const label = options.label ?? null
  const key = newStreamKey(sessionSecret)
  const { opensAt, closesAt } = streamWindow(live, startAt)
  const id = makeId('liveStream')
  const videoId = makeId('video')
  const now = new Date()

  const write = async (trx: Kysely<Database>): Promise<void> => {
    await trx
      .insertInto('videos')
      .values({
        id: videoId,
        game_id: gameId,
        kind: 'live',
        // The camera's name is part of the video's, because four angles of one
        // game called the same thing are four buttons a viewer cannot choose
        // between.
        title: `${options.videoTitle} — ${label ?? `Camera ${slot}`}`,
        storage: 'local',
        status: 'processing',
        hidden: true,
        created_at: now,
        updated_at: now
      })
      .execute()
    await trx
      .insertInto('live_streams')
      .values({
        id,
        game_id: gameId,
        team_id: teamId,
        user_id: userId,
        slot,
        label,
        key_hash: key.keyHash,
        key_prefix: key.keyPrefix,
        key_cipher: key.keyCipher,
        state: 'idle',
        opens_at: opensAt,
        closes_at: closesAt,
        video_id: videoId,
        created_by: userId,
        device_id: options.deviceId ?? null,
        device_model: options.deviceModel ?? null,
        records_locally: options.recordsLocally === true,
        director_claimed: options.directorClaimed === true,
        created_at: now,
        updated_at: now
      })
      .execute()
  }
  // Inside a caller's transaction when there is one, so a device request
  // holding the game's lock writes under it.
  if (db.isTransaction) await write(db)
  else await db.transaction().execute(write)

  return {
    id,
    gameId,
    teamId,
    userId,
    slot,
    label,
    keyCipher: key.keyCipher,
    keyPrefix: key.keyPrefix,
    state: 'idle',
    opensAt,
    closesAt,
    videoId,
    lastError: null,
    deviceId: options.deviceId ?? null,
    deviceModel: options.deviceModel ?? null,
    localRecording: 'none',
    recordsLocally: options.recordsLocally === true,
    directorClaimed: options.directorClaimed === true,
    key: key.key
  }
}

/**
 * Writes the camera's name onto the stream and onto its video, together.
 *
 * The video title is what the angle strip reads. Changing the label alone
 * would leave the strip showing the name the key was created with. The suffix
 * is the official name after this write, so a cleared label becomes
 * `Camera <slot>`.
 */
export async function setCameraName(
  db: Kysely<Database>,
  id: string,
  label: string | null
): Promise<void> {
  const now = new Date()
  await db.transaction().execute(async trx => {
    const row = await trx
      .selectFrom('live_streams')
      .select(['slot', 'video_id as videoId'])
      .where('id', '=', id)
      .executeTakeFirst()
    await trx
      .updateTable('live_streams')
      .set({ label, updated_at: now })
      .where('id', '=', id)
      .execute()
    if (row?.videoId == null) return
    const video = await trx
      .selectFrom('videos')
      .select(['title'])
      .where('id', '=', row.videoId)
      .executeTakeFirstOrThrow()
    await trx
      .updateTable('videos')
      .set({
        title: titledWith(video.title, labelFor({ slot: row.slot, label })),
        updated_at: now
      })
      .where('id', '=', row.videoId)
      .execute()
  })
}

/**
 * How long before the server first heard a stream its publisher may say the
 * first picture was captured. A phone holds a picture for a second before it
 * sends it, and the dial takes a few more; a minute is far past any of that.
 */
export const PUBLISHER_LEAD_MAX_MS = 60_000
/**
 * How long after the server first heard a stream its publisher may say the
 * first picture was captured: the two clocks' disagreement, and no more. A
 * later account is of a later publish, a reconnect, whose picture the video
 * already holds further on.
 */
export const PUBLISHER_LAG_MAX_MS = 2_000

/**
 * Places a stream's live video where its publisher says its first picture
 * was captured, on the wall clock: what the angle grid lines angles up by.
 *
 * The server's own placement is when the publish reached it, and a phone's
 * picture arrives anywhere from a fraction of a second to more than a second
 * after it was taken, so two phones filming one clock played out of step by
 * the difference. The publisher knows the capture time; nothing else does.
 *
 * The first placement holds. A reconnect continues the video's timeline, so
 * only the stream's first publish says where it starts: a video already
 * placed by its publisher is left alone, and so is an account too far from
 * when the server first heard the stream to be of that publish. Answers
 * whether the video moved.
 */
export async function placeByPublisher(
  db: Kysely<Database>,
  streamId: string,
  startedAt: Date,
  now = new Date()
): Promise<boolean> {
  const row = await db
    .selectFrom('live_streams')
    .select(['video_id as videoId', 'first_published_at as firstPublishedAt'])
    .where('id', '=', streamId)
    .executeTakeFirst()
  if (row?.videoId == null) return false
  // Before the ingest has said so, the publish being described is the one
  // arriving now.
  const heard = row.firstPublishedAt ?? now
  const lead = heard.getTime() - startedAt.getTime()
  if (lead > PUBLISHER_LEAD_MAX_MS || lead < -PUBLISHER_LAG_MAX_MS) {
    return false
  }
  const placed = await db
    .updateTable('videos')
    .set({ start_at: startedAt, start_at_source: 'publisher', updated_at: now })
    .where('id', '=', row.videoId)
    .where(eb =>
      eb.or([
        eb('start_at_source', 'is', null),
        eb('start_at_source', '=', 'liveSession')
      ])
    )
    .executeTakeFirst()
  return Number(placed.numUpdatedRows) > 0
}

/**
 * Replaces the key, leaving everything else as it was.
 *
 * The old key stops working the moment this returns — the ingest re-reads the
 * row within the second — which is the point of rotating one.
 */
export async function rotateLiveStreamKey(
  db: Kysely<Database>,
  id: string,
  sessionSecret: string
): Promise<string> {
  const key = newStreamKey(sessionSecret)
  await db
    .updateTable('live_streams')
    .set({
      key_hash: key.keyHash,
      key_prefix: key.keyPrefix,
      key_cipher: key.keyCipher,
      updated_at: new Date()
    })
    .where('id', '=', id)
    .execute()
  return key.key
}

/** How long a device model may be, counted after trimming. */
export const DEVICE_MODEL_MAX = 60

/** How long a device id may be. An install id is a UUID; this is room. */
const DEVICE_ID_MAX = 200

/**
 * What to store for a `deviceModel` field: the trimmed words, or null when it
 * was absent or blank.
 */
export function deviceModelOf(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return null
  if (trimmed.length > DEVICE_MODEL_MAX) {
    throw badRequest(
      `A device model can be at most ${DEVICE_MODEL_MAX} characters.`
    )
  }
  return trimmed
}

/** The install id a device sends, trimmed, or a refusal. */
export function deviceIdOf(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > DEVICE_ID_MAX) {
    throw badRequest('A device id must be 1 to 200 characters.')
  }
  return trimmed
}

/** What a request for a camera name that is already taken answers. */
export function labelTaken(label: string): Error {
  return conflict(`You already have a camera called ${label} on this game`)
}

/**
 * Whether one of this person's other active device streams on the game is
 * already called this, in any case.
 *
 * Only device streams collide: a browser's or streaming software's stream,
 * another person's, and a stream with no name never do. Ended and revoked
 * streams have let their name go.
 */
export async function deviceLabelTaken(
  db: Kysely<Database>,
  options: {
    gameId: string
    userId: number
    label: string | null
    exceptId?: string
  }
): Promise<boolean> {
  const { gameId, userId, label, exceptId } = options
  if (label == null) return false
  const row = await db
    .selectFrom('live_streams')
    .select('id')
    .where('game_id', '=', gameId)
    .where('user_id', '=', userId)
    .where('device_id', 'is not', null)
    .where('state', 'not in', ['revoked', 'ended'])
    .where('closes_at', 'is', null)
    .where(nameIs(label))
    .$if(exceptId != null, query => query.where('id', '<>', exceptId!))
    .executeTakeFirst()
  return row != null
}

export interface DeviceStreamRequest {
  gameId: string
  teamId: string
  startAt: Date
  /** The game, in words, for a new stream's video title. */
  videoTitle: string
  userId: number
  deviceId: string
  deviceModel: string | null
  /** The camera name, already cleaned by `cameraLabelOf`. */
  label: string | null
  /** A phone that keeps its own recording. Stored on a new or adopted stream. */
  recordsLocally?: boolean
  /** The stream the device already holds, sent by every automatic redial. */
  heldStreamId?: string
  live: LiveSettings
  sessionSecret: string
}

export interface DeviceStreamAnswer {
  row: LiveStreamRow
  /** The key, to build the URL from. */
  key: string
  /** A new stream, rather than one the device already held or adopted. */
  created: boolean
}

/** What a redial is told when somebody ended the camera it held. */
export const ENDED_CAMERA =
  'This camera was ended. Start streaming again to go live'

/**
 * The one path every device takes to its stream: a phone's Record video, TS
 * Director's Start Streaming, and every redial of either.
 *
 * Under the game's lock, in order:
 * 1. **Reuse** the caller's active stream on the game with this device and
 *    name, in any case.
 * 2. **Adopt** the caller's active stream with no device, the same name, that
 *    the legacy Director claim route returned: a device updating mid-game
 *    keeps that stream's key and live video. A stream made on the website for
 *    streaming software is never adopted.
 * 3. **Create** one in the lowest free slot, after revoking any ended stream
 *    of this device and name, which frees its slot and leaves its video.
 *
 * A redial names the stream it holds. If somebody ended or revoked that
 * stream, it is refused with 410 and nothing is created: End keeps a camera
 * off the air until its operator starts it again.
 */
export async function requestDeviceStream(
  db: Kysely<Database>,
  request: DeviceStreamRequest
): Promise<DeviceStreamAnswer> {
  const { gameId, userId, deviceId, label } = request
  return await db.transaction().execute(async trx => {
    await lockKeys(trx, [`liveStreams:${gameId}`])

    if (request.heldStreamId != null) {
      const held = await activeStream(trx, gameId, userId)
        .where('id', '=', request.heldStreamId)
        .executeTakeFirst()
      if (held == null) throw gone(ENDED_CAMERA)
    }

    const reused = await activeStream(trx, gameId, userId)
      .where(nameIs(label))
      .where('device_id', '=', deviceId)
      .orderBy('slot', 'asc')
      .executeTakeFirst()
    if (reused != null) {
      if (
        request.deviceModel != null &&
        request.deviceModel !== reused.deviceModel
      ) {
        await trx
          .updateTable('live_streams')
          .set({ device_model: request.deviceModel, updated_at: new Date() })
          .where('id', '=', reused.id)
          .execute()
      }
      const row = {
        ...asRow(reused),
        deviceModel: request.deviceModel ?? reused.deviceModel
      }
      return { row, key: revealKey(request.sessionSecret, row), created: false }
    }

    const adopted =
      label == null
        ? undefined
        : await activeStream(trx, gameId, userId)
            .where(nameIs(label))
            .where('device_id', 'is', null)
            .where('director_claimed', '=', true)
            .orderBy('slot', 'asc')
            .executeTakeFirst()
    if (adopted != null) {
      if (await deviceLabelTaken(trx, { gameId, userId, label })) {
        throw labelTaken(label!)
      }
      const recordsLocally = request.recordsLocally === true
      await trx
        .updateTable('live_streams')
        .set({
          device_id: deviceId,
          device_model: request.deviceModel,
          records_locally: recordsLocally,
          updated_at: new Date()
        })
        .where('id', '=', adopted.id)
        .execute()
      const row = {
        ...asRow(adopted),
        deviceId,
        deviceModel: request.deviceModel,
        recordsLocally
      }
      return { row, key: revealKey(request.sessionSecret, row), created: false }
    }

    if (await deviceLabelTaken(trx, { gameId, userId, label })) {
      throw labelTaken(label!)
    }

    // An ended stream of this device and name is history now: revoking it
    // gives its slot back, and its video stays as it is.
    const now = new Date()
    await trx
      .updateTable('live_streams')
      .set({ state: 'revoked', updated_at: now })
      .where('game_id', '=', gameId)
      .where('user_id', '=', userId)
      .where('device_id', '=', deviceId)
      .where(nameIs(label))
      .where('state', '<>', 'revoked')
      .where(eb =>
        eb.or([eb('closes_at', 'is not', null), eb('state', '=', 'ended')])
      )
      .execute()

    const slot = freeSlot(await myLiveStreams(trx, gameId, userId))
    if (slot == null) {
      throw badRequest(
        `You already have ${MAX_CAMERAS} cameras on this game. End one to add another.`
      )
    }
    const created = await createLiveStream(trx, {
      gameId,
      teamId: request.teamId,
      startAt: request.startAt,
      userId,
      slot,
      label: label ?? undefined,
      live: request.live,
      sessionSecret: request.sessionSecret,
      videoTitle: request.videoTitle,
      deviceId,
      deviceModel: request.deviceModel,
      recordsLocally: request.recordsLocally === true
    })
    const { key, ...row } = created
    return { row, key, created: true }
  })
}

/** The camera name matches, in any case; a null name matches only null. */
function nameIs(label: string | null): RawBuilder<boolean> {
  return sql<boolean>`lower(label) is not distinct from ${label?.toLowerCase() ?? null}`
}

/**
 * This person's streams on this game that are neither revoked nor ended: End
 * sets `closes_at`, and a stream the ingest finished is `ended`. The ingest
 * refuses either key. Its type is Kysely's query builder for these fields,
 * which is longer to write out than to read off the body.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function activeStream(
  trx: Transaction<Database>,
  gameId: string,
  userId: number
) {
  return trx
    .selectFrom('live_streams')
    .select(STREAM_FIELDS)
    .where('game_id', '=', gameId)
    .where('user_id', '=', userId)
    .where('state', 'not in', ['revoked', 'ended'])
    .where('closes_at', 'is', null)
}
