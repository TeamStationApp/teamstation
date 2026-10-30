import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { Kysely, Transaction } from 'kysely'

import { badRequest, notFound } from '../../common/errors'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { noteGameFigures } from '../socket/syncRevision'
import { spaceConfigured, type SpaceSettings } from './spacesHls'
import { deleteVideoFromSpace } from './spacesVideo'

export interface DeleteVideoContext {
  db: Kysely<Database>
  space: SpaceSettings
  mediaRoot: string
}

export interface DeleteVideoOptions {
  /**
   * Videos this one displaced that stay hidden, because they are going too:
   * a camera's delete takes its live video after what replaced it, and must
   * not show it again in between, or for good if its own delete then fails.
   */
  keepHidden?: readonly string[]
}

export interface DeletedVideo {
  removedFromSpace: number
  /** What came back out of hiding because this went. */
  restored: string[]
}

/**
 * Stops the cameras on a video that is about to go pointing at it. They keep
 * their rows, the record that a key existed. What replaced the video goes on
 * standing for them (`replacement_video_id`): its row keeps playing that video
 * and showing its length, and a delete of the camera still finds it, though the
 * video that said so is gone.
 */
export async function letCamerasGo(
  trx: Transaction<Database>,
  videoId: string,
  now: Date = new Date()
): Promise<void> {
  await trx
    .updateTable('live_streams')
    .set(eb => ({
      video_id: null,
      replacement_video_id: eb
        .selectFrom('videos')
        .select('replaced_by')
        .where('id', '=', videoId),
      updated_at: now
    }))
    .where('video_id', '=', videoId)
    .execute()
}

/**
 * Deletes a recording, its files, and what the Space holds of it.
 *
 * Whether the caller may is the caller's to check. Refused for a legacy
 * recording, and while something is still streaming into it.
 */
export async function deleteVideo(
  context: DeleteVideoContext,
  videoId: string,
  options: DeleteVideoOptions = {}
): Promise<DeletedVideo> {
  const keepHidden = options.keepHidden ?? []
  const { db, space, mediaRoot } = context
  const video = await db
    .selectFrom('videos')
    .select(['storage', 'game_id as gameId'])
    .where('id', '=', videoId)
    .executeTakeFirst()
  if (video == null) throw notFound()
  if (video.storage === 'peertube') {
    throw badRequest(
      'That recording came from the old server, which this one only reads. It cannot be deleted here.'
    )
  }
  const cameras = await db
    .selectFrom('live_streams')
    .select(['state'])
    .where('video_id', '=', videoId)
    .execute()
  if (cameras.some(row => row.state === 'publishing')) {
    throw badRequest(
      'Something is still streaming into that recording. End the camera first.'
    )
  }

  // The Space first. If it fails the row stays, and the delete can be
  // tried again; doing it the other way round loses the only record of
  // which objects were the video's, and they are then paid for for ever.
  let removedFromSpace = 0
  if (spaceConfigured(space)) {
    const { deleted } = await deleteVideoFromSpace({ space, videoId })
    removedFromSpace = deleted
  }

  const local = join(mediaRoot, 'work', 'videos', videoId)
  await rm(local, { recursive: true, force: true })

  // The rows change together, and the game's event hears of it from the
  // transaction's last statements.
  const restored = await atomic(db, async trx => {
    if (cameras.length > 0) await letCamerasGo(trx, videoId)
    // Anything this video displaced comes back. A recording is hidden
    // and dated for deletion only because something better took its
    // place, so deleting that something takes the reason away with it —
    // and without this, undoing a bad upload quietly destroys the
    // recording the upload pushed aside, which is the opposite of what
    // deleting it was for. The foreign key clears the pointer; the
    // hiding and the purge date are ours to undo.
    const back = await trx
      .updateTable('videos')
      .set({ hidden: false, purge_after: null, updated_at: new Date() })
      .where('replaced_by', '=', videoId)
      .$if(keepHidden.length > 0, query =>
        query.where('id', 'not in', keepHidden)
      )
      .returning('id')
      .execute()

    await trx.deleteFrom('videos').where('id', '=', videoId).execute()
    // One video fewer on its season's row: Home's lists are told.
    if (video.gameId != null) await noteGameFigures(trx, video.gameId)
    return back
  })

  return { removedFromSpace, restored: restored.map(one => one.id) }
}
