import { type Kysely, type RawBuilder, sql } from 'kysely'

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
 * One event per take, whatever asks: the event's source is the stream, and
 * `notification_events` holds one revision of each source once. A camera can
 * go on to a second take after its first was uploaded or deleted, which is its
 * next revision.
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
 * Records the reminder for this stream's take, once. Returns whether this call
 * made it, so a repeated "recorded" adds nothing while the last reminder still
 * stands. One that has been settled was for a take that has gone, so this one
 * is new. A camera deleted gets none: no upload to it is taken, so nothing
 * would ever settle it. A camera removed does: its take can still be uploaded.
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
    .where('discarded_at', 'is', null)
    .executeTakeFirst()
  if (stream == null) return false
  const last = await db
    .selectFrom('notification_events')
    .leftJoin('notification_receipts', join =>
      join
        .onRef('notification_receipts.event_id', '=', 'notification_events.id')
        .on('notification_receipts.user_id', '=', stream.userId)
    )
    .select([
      'notification_events.revision as revision',
      'notification_receipts.dismissed_at as settledAt'
    ])
    .where('notification_events.source_type', '=', RECORDING_UPLOAD)
    .where('notification_events.source_id', '=', stream.id)
    .orderBy('notification_events.revision', 'desc')
    .executeTakeFirst()
  const made = await db
    .insertInto('notification_events')
    .values({
      id: makeId('audit'),
      source_type: RECORDING_UPLOAD,
      source_id: stream.id,
      revision:
        last == null ? 1 : last.revision + (last.settledAt == null ? 0 : 1),
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
 * Warns the owner of every camera whose phone still holds a copy it has not
 * uploaded, 27 up to 28 days after that copy's 30 days began: the phone deletes
 * it 30 days after the take ended. The last publish is close to that moment,
 * where `ended_at` can be days later, or never on a game with no end. A camera
 * that never reached the server has its end to go by, and with none of that
 * the moment its phone said it holds the take. A take recorded before the
 * 30-day limit began counts from the first sweep that saw it, which its phone
 * reports (`local_copy_from`), and its phone keeps it until that report lands.
 *
 * Older cameras are not warned, so the first run over cameras long past tells
 * nobody about a deadline already gone. Nor are cameras deleted, which nothing
 * can be uploaded to, or one whose take has a finished upload: the phone
 * deletes a take once its upload lands, and that copy is on the server. An
 * upload finished before the camera last sent video, or before the
 * phone last said it holds a take, was of an earlier take, and this one is
 * still at risk. A camera removed is warned like any other: its take can still
 * be uploaded, and may be the angle's only copy.
 *
 * One event per deadline: under the revision of the take's reminder, so the
 * hourly run repeats nothing and a later take is warned about in its turn, or
 * the next one up when the last warning came before these 30 days began.
 * Returns how many this run added.
 */
export async function recordLocalCopyWarnings(
  db: Kysely<Database>,
  now: Date = new Date()
): Promise<number> {
  const filmedUntil = sql<Date>`coalesce(live_streams.last_published_at, live_streams.ended_at)`
  const lastEvent = (
    type: string,
    field: 'created_at' | 'revision'
  ): RawBuilder<unknown> => sql`(
    select max(${sql.ref(`notification_events.${field}`)})
      from notification_events
     where notification_events.source_type = ${type}
       and notification_events.source_id = live_streams.id
  )`
  const lastReminder = (
    field: 'created_at' | 'revision'
  ): RawBuilder<unknown> => lastEvent(RECORDING_UPLOAD, field)
  const countsFrom = sql<Date>`coalesce(
    greatest(live_streams.local_copy_from, live_streams.last_published_at),
    live_streams.ended_at,
    ${lastReminder('created_at')}
  )`
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
      'away.name as awayTeamName',
      sql<number | null>`${lastReminder('revision')}`.as('take'),
      sql<number | null>`${lastEvent(LOCAL_COPY_EXPIRING, 'revision')}`.as(
        'lastWarning'
      ),
      sql<Date | null>`${lastEvent(LOCAL_COPY_EXPIRING, 'created_at')}`.as(
        'lastWarnedAt'
      ),
      countsFrom.as('countsFrom')
    ])
    .where('live_streams.records_locally', '=', true)
    .where('live_streams.local_recording', '=', 'recorded')
    .where('live_streams.discarded_at', 'is', null)
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('director_uploads')
            .select('director_uploads.id')
            .whereRef('director_uploads.live_stream_id', '=', 'live_streams.id')
            .where('director_uploads.state', '=', 'ready')
            .where(
              sql<boolean>`director_uploads.updated_at >= greatest(${filmedUntil}, ${lastReminder('created_at')})`
            )
        )
      )
    )
    .where(countsFrom, '<=', new Date(now.getTime() - WARN_AFTER_DAYS * DAY_MS))
    .where(
      countsFrom,
      '>',
      new Date(now.getTime() - (WARN_AFTER_DAYS + 1) * DAY_MS)
    )
    .execute()
  let warned = 0
  for (const stream of streams) {
    const warnedBefore =
      stream.lastWarnedAt != null &&
      new Date(stream.lastWarnedAt) < new Date(stream.countsFrom)
    const made = await db
      .insertInto('notification_events')
      .values({
        id: makeId('audit'),
        created_at: now,
        source_type: LOCAL_COPY_EXPIRING,
        source_id: stream.id,
        revision: Math.max(
          stream.take ?? 1,
          (stream.lastWarning ?? 0) + (warnedBefore ? 1 : 0)
        ),
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
