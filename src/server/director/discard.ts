import { rm } from 'node:fs/promises'

import { type Kysely, sql } from 'kysely'

import { HttpError } from '../../common/errors'
import type { Database } from '../db/database'
import {
  deleteVideo,
  type DeleteVideoContext,
  type DeleteVideoOptions
} from '../media/deleteVideo'
import { settleRecordingReminder } from '../notifications/recordingReminders'
import { uploadDir } from './uploads'

export interface DiscardContext extends DeleteVideoContext {
  /** Where an upload's parts wait. */
  uploadsDir: string
}

/** Deletes a video, for a caller that may find somebody got there first. */
export async function deleteVideoIfThere(
  context: DeleteVideoContext,
  videoId: string,
  options: DeleteVideoOptions = {}
): Promise<void> {
  try {
    await deleteVideo(context, videoId, options)
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== 'notFound') throw error
  }
}

/**
 * The upload from TS Director or the Distributor that took this camera's video
 * off the game, if it goes with the camera. Such an upload names no stream, so
 * it says nothing of whose camera it stands for. It goes only when the camera's
 * owner uploaded it, and no other camera's live video still points at it: the
 * coverage rule can have it replace several cameras, and a video somebody else
 * uploaded is theirs to delete.
 *
 * The link is the live video's `replaced_by`, or the camera's own
 * `replacement_video_id` once a purge or a delete has taken the live video.
 *
 * One that stays loses this camera's link to it. Clearing that leaves the live
 * video hidden, on its way out, and keeps a delete run again from deciding
 * anything about it after the camera has let it go.
 */
async function replacementOf(
  db: Kysely<Database>,
  streamId: string,
  ownerId: string,
  videoId: string | null,
  kept: string | null
): Promise<string | undefined> {
  const live =
    videoId == null
      ? undefined
      : await db
          .selectFrom('videos')
          .select('replaced_by as replacedBy')
          .where('id', '=', videoId)
          .executeTakeFirst()
  const replacement = live?.replacedBy ?? kept
  if (replacement == null) return undefined
  const unnamed = await db
    .selectFrom('director_uploads')
    .select('user_id as userId')
    .where('video_id', '=', replacement)
    .where('live_stream_id', 'is', null)
    .executeTakeFirst()
  const shared = await db
    .selectFrom('live_streams')
    .leftJoin('videos', 'videos.id', 'live_streams.video_id')
    .select('live_streams.id')
    .where('live_streams.id', '<>', streamId)
    .where(eb =>
      eb.or([
        eb('videos.replaced_by', '=', replacement),
        eb('live_streams.replacement_video_id', '=', replacement)
      ])
    )
    .executeTakeFirst()
  if (unnamed?.userId === ownerId && shared == null) return replacement
  const now = new Date()
  await db
    .updateTable('live_streams')
    .set({ replacement_video_id: null, updated_at: now })
    .where('id', '=', streamId)
    .execute()
  if (videoId != null) {
    await db
      .updateTable('videos')
      .set({ replaced_by: null, updated_at: now })
      .where('id', '=', videoId)
      .execute()
  }
  return undefined
}

/**
 * Deletes a camera's recording for good: its live video, every upload of it,
 * and the parts of any upload that never finished. Answers the videos deleted.
 *
 * Claimed first. `discarded_at` is what an upload looks at, so once it is
 * written no upload can bring this video back: one that writes its video on
 * its row before this reads the rows is deleted here, and one that writes it
 * after finds the camera deleted and deletes its own (`takeItIn`). The camera
 * leaves the list at the same moment, and its owner's delete stands whatever
 * happens next.
 *
 * Every step can run again, and `finishDiscards` runs them again for a camera
 * whose delete stopped partway. The replacement goes before the live video,
 * because the live video is the only record of what replaced it. Deleting a
 * video shows again what it replaced, so these deletes leave this camera's
 * own videos hidden: the live video stays off the game while its own delete
 * runs, and after it if that fails.
 */
export async function discardStream(
  context: DiscardContext,
  streamId: string
): Promise<string[]> {
  const { db, uploadsDir } = context
  const now = new Date()
  const claimed = await db
    .updateTable('live_streams')
    .set({
      discarded_at: sql`coalesce(discarded_at, ${now})`,
      updated_at: now
    })
    .where('id', '=', streamId)
    .returning([
      'video_id as videoId',
      'user_id as ownerId',
      'replacement_video_id as replacementVideoId'
    ])
    .executeTakeFirstOrThrow()
  await settleRecordingReminder(db, streamId, now)

  const uploads = await db
    .selectFrom('director_uploads')
    .select(['id', 'state', 'video_id as videoId'])
    .where('live_stream_id', '=', streamId)
    .execute()
  const unfinished = uploads.filter(one => one.state !== 'ready')
  if (unfinished.length > 0) {
    await db
      .updateTable('director_uploads')
      .set({ state: 'abandoned', step: null, updated_at: now })
      .where(
        'id',
        'in',
        unfinished.map(one => one.id)
      )
      .execute()
  }
  for (const upload of unfinished) {
    await rm(uploadDir(uploadsDir, upload.id), { recursive: true, force: true })
  }

  const videoIds = [
    ...new Set([
      await replacementOf(
        db,
        streamId,
        claimed.ownerId,
        claimed.videoId,
        claimed.replacementVideoId
      ),
      ...uploads.map(one => one.videoId),
      claimed.videoId
    ])
  ].filter(id => id != null)
  const own = [...uploads.map(one => one.videoId), claimed.videoId].filter(
    id => id != null
  )
  for (const videoId of videoIds) {
    await deleteVideoIfThere(context, videoId, { keepHidden: own })
  }
  return videoIds
}

/**
 * Carries on every delete that stopped partway: the Space refused, or this
 * process died. Answers how many it finished. One that fails again is left for
 * the next run, and does not stop the rest.
 */
export async function finishDiscards(context: DiscardContext): Promise<number> {
  const { db } = context
  const streams = await db
    .selectFrom('live_streams')
    .select('id')
    .where('discarded_at', 'is not', null)
    .where(eb =>
      eb.or([
        eb('video_id', 'is not', null),
        eb('replacement_video_id', 'is not', null),
        eb.exists(
          eb
            .selectFrom('director_uploads')
            .select('director_uploads.id')
            .whereRef('director_uploads.live_stream_id', '=', 'live_streams.id')
            .where(wanted =>
              wanted.or([
                wanted('director_uploads.video_id', 'is not', null),
                wanted('director_uploads.state', 'not in', [
                  'ready',
                  'abandoned'
                ])
              ])
            )
        )
      ])
    )
    .execute()
  let finished = 0
  for (const stream of streams) {
    try {
      await discardStream(context, stream.id)
      finished += 1
    } catch (error) {
      console.error(`finishing the delete of ${stream.id}: ${String(error)}`)
    }
  }
  return finished
}
