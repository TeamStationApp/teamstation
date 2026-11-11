import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import type { ImageSize } from '../media/images'
import { imageUrl, TILE_SIZE } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'

/**
 * Each league's picture (`leagues.logo_path`), signed, by league id, in one
 * read: what a season with no picture of its own is drawn with
 * (`leaguePictureUrl`). A league without one, or that is gone, has no entry.
 */
export async function leaguePictures(
  db: Kysely<Database>,
  space: SpaceSettings,
  leagueIds: Iterable<string | null | undefined>,
  size: ImageSize = TILE_SIZE
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      [...leagueIds].filter((id): id is string => id != null && id !== '')
    )
  ]
  const pictures = new Map<string, string>()
  if (ids.length === 0) return pictures
  const rows = await db
    .selectFrom('leagues')
    .select(['id', 'logo_path'])
    .where('id', 'in', ids)
    .execute()
  for (const row of rows) {
    const url = imageUrl(space, row.logo_path, size)
    if (url != null) pictures.set(row.id, url)
  }
  return pictures
}
