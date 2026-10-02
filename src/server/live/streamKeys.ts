import { randomBytes } from 'crypto'
import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import { rtmpOrigin } from '../../common/primaryUrl'
import { hashToken } from '../auth/tokens'
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
  return `gs_${randomBytes(16).toString('base64url')}`
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
}

/** How many cameras one person may point at one game. */
export const MAX_CAMERAS = 4

/** What a camera is called when nobody has said. */
export function labelFor(row: { slot: number; label: string | null }): string {
  return row.label ?? `Camera ${row.slot}`
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
  'last_error as lastError'
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

  await db.transaction().execute(async trx => {
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
        created_at: now,
        updated_at: now
      })
      .execute()
  })

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
    key: key.key
  }
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
