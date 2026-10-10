import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Kysely } from 'kysely'

import { unavailable } from '../../common/errors'
import {
  asCatalogId,
  type AvailablePicture,
  catalogPicture,
  pictureCatalog,
  pictureCatalogVersion
} from '../../common/pictureCatalog'
import type { Database } from '../db/database'
import { imageKey, putObject, sha256Of } from './images'
import { imageUrl, PROFILE_SIZE } from './imageUrls'
import { spaceConfigured, type SpaceSettings } from './spacesHls'

export async function availablePictures(space: SpaceSettings): Promise<{
  version: number
  entries: AvailablePicture[]
}> {
  if (!spaceConfigured(space))
    throw unavailable(
      'The picture catalog is unavailable. Add a photo or use initials.'
    )
  const result = {
    version: pictureCatalogVersion,
    entries: pictureCatalog.map(entry => ({
      ...entry,
      url: imageUrl(space, entry.prefix, PROFILE_SIZE)!
    }))
  }
  try {
    await Promise.all(
      result.entries.map(async entry => {
        const response = await fetch(entry.url, {
          // Image URLs are signed for GET; Range is deliberately unsigned.
          headers: { Range: 'bytes=0-0' },
          signal: AbortSignal.timeout(5000)
        })
        await response.arrayBuffer()
        if (!response.ok) throw new Error('Catalog rendition unavailable')
      })
    )
  } catch {
    throw unavailable(
      'The picture catalog is unavailable. Retry, add a photo or use initials.'
    )
  }
  return result
}

/** Publish each immutable rendition once; selecting an image never calls this. */
export async function publishPictureCatalog(
  space: SpaceSettings,
  assetDirectory: string
): Promise<number> {
  if (!spaceConfigured(space))
    throw unavailable('No picture store is configured')
  let uploaded = 0
  for (const entry of pictureCatalog) {
    for (const size of [96, 192] as const) {
      const bytes = await readFile(
        join(assetDirectory, `${entry.id}-${size}.png`)
      )
      if (size === 192 && sha256Of(bytes) !== entry.sha256)
        throw new Error('Catalog image hash differs from its manifest')
      const existing = await fetch(imageUrl(space, entry.prefix, size)!)
      if (existing.ok) {
        if (
          sha256Of(Buffer.from(await existing.arrayBuffer())) !==
          sha256Of(bytes)
        )
          throw new Error('Immutable catalog object has different bytes')
        continue
      }
      if (existing.status !== 404)
        throw unavailable('The picture store did not answer')
      await putObject({
        space,
        key: imageKey(entry.prefix, size),
        body: bytes,
        contentType: 'image/png'
      })
      uploaded += 1
    }
  }
  return uploaded
}

/** A catalog choice is a manual selection, protected from subsequent imports. */
export async function selectAccountCatalogPicture(
  db: Kysely<Database>,
  userId: number,
  raw: unknown
): Promise<void> {
  const entry = catalogPicture(asCatalogId(raw))!
  if (entry.kind !== 'photo')
    throw new TypeError('Choose a sports profile picture')
  await db
    .updateTable('users')
    .set({
      picture_catalog_id: entry.id,
      avatar_path: entry.prefix,
      avatar_sha256: entry.sha256,
      avatar_source: 'upload',
      avatar_updated_at: new Date()
    })
    .where('id', '=', userId)
    .execute()
}
