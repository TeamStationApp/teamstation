import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import { RECORDING_UPLOAD } from '../../common/notifications'
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

/**
 * Settles this stream's reminder for its owner: the upload landed. The
 * receipt is upserted, because a reminder nobody opened has none yet.
 */
export async function settleRecordingReminder(
  db: Kysely<Database>,
  streamId: string,
  now: Date = new Date()
): Promise<void> {
  const event = await db
    .selectFrom('notification_events')
    .innerJoin(
      'live_streams',
      'live_streams.id',
      'notification_events.source_id'
    )
    .select(['notification_events.id as id', 'live_streams.user_id as userId'])
    .where('notification_events.source_type', '=', RECORDING_UPLOAD)
    .where('notification_events.source_id', '=', streamId)
    .executeTakeFirst()
  if (event == null) return
  await db
    .insertInto('notification_receipts')
    .values({
      event_id: event.id,
      user_id: event.userId,
      viewed_at: now,
      dismissed_at: now
    })
    .onConflict(oc =>
      oc.columns(['event_id', 'user_id']).doUpdateSet({ dismissed_at: now })
    )
    .execute()
}
