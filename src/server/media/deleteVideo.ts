import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { Kysely } from 'kysely'

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

export interface DeletedVideo {
  removedFromSpace: number
  /** What came back out of hiding because this went. */
  restored: string[]
}

/**
 * Deletes a recording, its files, and what the Space holds of it.
 *
 * Whether the caller may is the caller's to check. Refused for a legacy
 * recording, and while something is still streaming into it.
 */
export async function deleteVideo(
  context: DeleteVideoContext,
  videoId: string
): Promise<DeletedVideo> {
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
    // The cameras keep their rows — they are the record that a key
    // existed — and simply stop pointing at a video that is gone.
    if (cameras.length > 0) {
      await trx
        .updateTable('live_streams')
        .set({ video_id: null, updated_at: new Date() })
        .where('video_id', '=', videoId)
        .execute()
    }
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
      .returning('id')
      .execute()

    await trx.deleteFrom('videos').where('id', '=', videoId).execute()
    // One video fewer on its season's row: Home's lists are told.
    if (video.gameId != null) await noteGameFigures(trx, video.gameId)
    return back
  })

  return { removedFromSpace, restored: restored.map(one => one.id) }
}
