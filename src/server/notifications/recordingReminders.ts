import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import {
  LOCAL_COPY_EXPIRING,
  RECORDING_UPLOAD
} from '../../common/notifications'
import type { Database } from '../db/database'
import { labelFor } from '../live/streamKeys'

/**
 * A reminder to upload a phone's recording of one camera angle.
 *
 * The live copy of a phone's angle went out over whatever network the field
 * had; the phone kept a better one. Until that copy is uploaded, the reminder
 * stays in its owner's Pending. It goes when they dismiss it or when the
 * upload replaces the angle's live copy.
 *
 * One event per stream, whatever asks: the event's source is the stream, and
 * `notification_events` holds one revision of each source once.
 */

export const REMINDER_TITLE = 'Upload your recording'

export const LOCAL_COPY_WARNING_TITLE = "This phone's copy is expiring"

const DAY_MS = 24 * 60 * 60 * 1000

/** How old an ended camera's unuploaded copy is when its owner is warned. */
const WARN_AFTER_DAYS = 27

/** "Home Plate on iPhone 13 Pro — provide a higher-quality copy …" */
export function reminderDescription(
  angle: string,
  deviceModel: string | null
): string {
  const where = deviceModel == null ? angle : `${angle} on ${deviceModel}`
  return `${where} — provide a higher-quality copy for future viewing.`
}

/**
 * Records the reminder for this stream, once. Returns whether this call made
 * it, so a repeated "recorded" adds nothing.
 */
export async function recordRecordingReminder(
  db: Kysely<Database>,
  streamId: string
): Promise<boolean> {
  const stream = await db
    .selectFrom('live_streams')
    .select([
      'id',
      'game_id as gameId',
      'user_id as userId',
      'slot',
      'label',
      'device_model as deviceModel'
    ])
    .where('id', '=', streamId)
    .executeTakeFirstOrThrow()
  const made = await db
    .insertInto('notification_events')
    .values({
      id: makeId('audit'),
      source_type: RECORDING_UPLOAD,
      source_id: stream.id,
      revision: 1,
      actor_id: stream.userId,
      metadata: {
        title: REMINDER_TITLE,
        description: reminderDescription(labelFor(stream), stream.deviceModel),
        gameId: stream.gameId,
        liveStreamId: stream.id
      },
      recorded_recipients: [stream.userId]
    })
    .onConflict(oc =>
      oc.columns(['source_type', 'source_id', 'revision']).doNothing()
    )
    .executeTakeFirst()
  return Number(made.numInsertedOrUpdatedRows ?? 0) > 0
}

/** "Home Plate on iPhone 13 Pro, Owls at Hawks — this phone's copy …" */
export function localCopyWarningDescription(
  angle: string,
  deviceModel: string | null,
  game: string
): string {
  const where = deviceModel == null ? angle : `${angle} on ${deviceModel}`
  return `${where}, ${game} — this phone's copy will be deleted in 3 days. Upload it to keep it.`
}

/**
 * Warns the owner of every camera that ended 27 up to 28 days ago and whose
 * phone still holds a copy it has not uploaded: the phone deletes that copy at
 * 30 days. Older cameras are not warned, so the first run over cameras that
 * ended long ago tells nobody about a deadline already gone.
 *
 * One event per stream: the source is the stream, and `notification_events`
 * holds one revision of each source once, so the hourly run repeats nothing.
 * Returns how many this run added.
 */
export async function recordLocalCopyWarnings(
  db: Kysely<Database>,
  now: Date = new Date()
): Promise<number> {
  const streams = await db
    .selectFrom('live_streams')
    .innerJoin('games', 'games.id', 'live_streams.game_id')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'live_streams.id as id',
      'live_streams.game_id as gameId',
      'live_streams.user_id as userId',
      'live_streams.slot as slot',
      'live_streams.label as label',
      'live_streams.device_model as deviceModel',
      'home.name as homeTeamName',
      'away.name as awayTeamName'
    ])
    .where('live_streams.records_locally', '=', true)
    .where('live_streams.local_recording', '=', 'recorded')
    .where('live_streams.discarded_at', 'is', null)
    .where(
      'live_streams.ended_at',
      '<=',
      new Date(now.getTime() - WARN_AFTER_DAYS * DAY_MS)
    )
    .where(
      'live_streams.ended_at',
      '>',
      new Date(now.getTime() - (WARN_AFTER_DAYS + 1) * DAY_MS)
    )
    .execute()
  let warned = 0
  for (const stream of streams) {
    const made = await db
      .insertInto('notification_events')
      .values({
        id: makeId('audit'),
        source_type: LOCAL_COPY_EXPIRING,
        source_id: stream.id,
        revision: 1,
        actor_id: stream.userId,
        metadata: {
          title: LOCAL_COPY_WARNING_TITLE,
          description: localCopyWarningDescription(
            labelFor(stream),
            stream.deviceModel,
            `${stream.awayTeamName} at ${stream.homeTeamName}`
          ),
          gameId: stream.gameId,
          liveStreamId: stream.id
        },
        recorded_recipients: [stream.userId]
      })
      .onConflict(oc =>
        oc.columns(['source_type', 'source_id', 'revision']).doNothing()
      )
      .executeTakeFirst()
    if (Number(made.numInsertedOrUpdatedRows ?? 0) > 0) warned += 1
  }
  return warned
}

/**
 * Settles this stream's reminder and copy warning for its owner: the upload
 * landed, or the copy is gone. Each receipt is upserted, because a reminder
 * nobody opened has none yet.
 */
export async function settleRecordingReminder(
  db: Kysely<Database>,
  streamId: string,
  now: Date = new Date()
): Promise<void> {
  const events = await db
    .selectFrom('notification_events')
    .innerJoin(
      'live_streams',
      'live_streams.id',
      'notification_events.source_id'
    )
    .select(['notification_events.id as id', 'live_streams.user_id as userId'])
    .where('notification_events.source_type', 'in', [
      RECORDING_UPLOAD,
      LOCAL_COPY_EXPIRING
    ])
    .where('notification_events.source_id', '=', streamId)
    .execute()
  if (events.length === 0) return
  await db
    .insertInto('notification_receipts')
    .values(
      events.map(event => ({
        event_id: event.id,
        user_id: event.userId,
        viewed_at: now,
        dismissed_at: now
      }))
    )
    .onConflict(oc =>
      oc.columns(['event_id', 'user_id']).doUpdateSet({ dismissed_at: now })
    )
    .execute()
}
