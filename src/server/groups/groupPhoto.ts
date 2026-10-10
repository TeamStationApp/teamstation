import type { Kysely } from 'kysely'

import type { AccountPicture } from '../../common/accountSettings'
import { unavailable, unsupportedMedia } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import type { Database } from '../db/database'
import { storeImage, UnreadableImage } from '../media/images'
import type { MediaContext } from '../media/mediaContext'
import { spaceConfigured } from '../media/spacesHls'
import { asPictureBody, storeTeamLogo } from '../teams/storeTeamPictures'

export async function storeGroupPhoto(
  db: Kysely<Database>,
  media: MediaContext,
  ref: GroupRef,
  image: AccountPicture
): Promise<string | null> {
  const picture = asPictureBody({ image, source: 'upload' })
  if (ref.kind === 'team') {
    await storeTeamLogo(db, media, ref.id, picture)
    return (
      await db
        .selectFrom('teams')
        .select('logo_path')
        .where('id', '=', ref.id)
        .executeTakeFirstOrThrow()
    ).logo_path
  }
  if (!spaceConfigured(media.space))
    throw unavailable('No picture store is configured')
  try {
    const stored = await storeImage({
      ffmpegPath: media.ffmpegPath,
      space: media.space,
      kind: 'league',
      entityId: ref.id,
      source: picture.bytes
    })
    if (stored == null) throw unavailable('The picture could not be saved')
    await db
      .updateTable(ref.kind === 'league' ? 'leagues' : 'seasons')
      .set({
        logo_path: stored.pathPrefix,
        logo_sha256: stored.sha256,
        logo_source: 'upload',
        picture_catalog_id: null
      })
      .where('id', '=', ref.id)
      .execute()
    return stored.pathPrefix
  } catch (error) {
    if (error instanceof UnreadableImage)
      throw unsupportedMedia('That is not a picture TeamStation can read')
    throw unavailable('The picture store did not answer')
  }
}
