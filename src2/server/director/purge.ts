import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import type { SpaceSettings } from '../media/spacesHls'
import { deleteVideoFromSpace } from '../media/spacesVideo'

/**
 * Recordings that were replaced, once their month is up.
 *
 * An upload that replaces a live recording hides it at once and writes the
 * date it may be deleted — a month out, so a replacement nobody has checked
 * has four weeks to be noticed and undone. Writing that date was only ever
 * half the promise: until this, nothing read it, so a displaced recording was
 * hidden for ever and the Space was paid for it for ever, while the migration
 * and the route both said it would be deleted.
 *
 * **The Space first, the row second.** If the objects go and the row stays,
 * the next sweep tries again and finds nothing to delete, which is harmless.
 * The other way round loses the only record of which objects belonged to the
 * video, and they are then paid for with nothing left pointing at them —
 * which is the failure this whole sweep exists to prevent.
 */
export interface Purgeable {
  id: string
  purgeAfter: Date | null
  hidden: boolean
  replacedBy: string | null
  /** `peertube` is a tree this server reads and does not own. */
  storage?: string
}

/**
 * Which of these are due to go.
 *
 * Four things have to be true, and each has cost somebody something when it
 * was not checked: the date has passed, the recording is **still hidden**, it
 * is **still replaced**, and it is one this server may delete at all. A
 * recording somebody has brought back out of hiding — or whose replacement
 * has since been deleted, which clears the pointer — is one a person has
 * acted on, and its old purge date is not a reason to delete it behind them.
 *
 * A recording still in PeerTube's tree is refused for the same reason the
 * delete route refuses it: this server reads that tree and does not own it.
 */
export function dueForPurge(videos: Purgeable[], now: Date): string[] {
  return videos
    .filter(one => one.purgeAfter != null && one.purgeAfter <= now)
    .filter(one => one.hidden && one.replacedBy != null)
    .filter(one => one.storage !== 'peertube')
    .map(one => one.id)
}

/**
 * Deletes what is due, and answers with what went.
 *
 * Errors are swallowed per video on purpose: one recording whose objects will
 * not delete must not stop the rest of the sweep, and the row stays behind so
 * the next sweep tries again.
 */
export async function purgeReplacedRecordings(options: {
  db: Kysely<Database>
  space: SpaceSettings
  mediaDir: string
  now?: Date
  log?: (message: string) => void
}): Promise<string[]> {
  const { db, space, mediaDir, now = new Date(), log } = options
  const rows = await db
    .selectFrom('videos')
    .select([
      'id',
      'purge_after as purgeAfter',
      'hidden',
      'replaced_by as replacedBy',
      'storage'
    ])
    .where('purge_after', 'is not', null)
    .execute()

  const due = dueForPurge(
    rows.map(one => ({
      id: one.id,
      purgeAfter: one.purgeAfter == null ? null : new Date(one.purgeAfter),
      hidden: one.hidden,
      replacedBy: one.replacedBy,
      storage: one.storage
    })),
    now
  )

  const gone: string[] = []
  for (const videoId of due) {
    try {
      // A camera still streaming into it is the delete route's other refusal,
      // and it is checked here for the same reason: the row is in use.
      const publishing = await db
        .selectFrom('live_streams')
        .select('id')
        .where('video_id', '=', videoId)
        .where('state', '=', 'publishing')
        .executeTakeFirst()
      if (publishing != null) continue

      // The Space first, then the copy on this disk, then the row — the same
      // order and the same steps as deleting one by hand. Doing less than the
      // route does is how a sweep leaves work directories behind for ever.
      await deleteVideoFromSpace({ space, videoId })
      // The Space has gone by here, so the row must go too: leaving it
      // because a directory would not delete gives a recording whose media
      // is already gone, retried every six hours for ever. The directory is
      // reported and left for a person.
      await rm(join(mediaDir, 'work', 'videos', videoId), {
        recursive: true,
        force: true
      }).catch((error: unknown) => {
        log?.(`purge ${videoId}: its work directory stayed: ${String(error)}`)
      })
      await db
        .updateTable('live_streams')
        .set({ video_id: null, updated_at: now })
        .where('video_id', '=', videoId)
        .execute()
      await db.deleteFrom('videos').where('id', '=', videoId).execute()
      gone.push(videoId)
      log?.(`purged ${videoId}, replaced and a month old`)
    } catch (error) {
      log?.(`purge ${videoId}: ${String(error)}`)
    }
  }
  return gone
}
