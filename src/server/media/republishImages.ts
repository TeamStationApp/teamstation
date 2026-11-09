import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'
import {
  copyObject,
  deleteObject,
  imageKey,
  type ImageKind,
  imagePathPrefix,
  isPublicImagePrefix,
  sizesFor
} from './images'
import { isReadOnlySourceKey } from './presign'
import { spaceConfigured, type SpaceSettings } from './spacesHls'

/**
 * Moving the pictures stored before names were random to public ones.
 *
 * An old prefix carries the entity id and a hash of the bytes, so its objects
 * stay private and every URL to them is signed. Each is copied, size by size,
 * to a new random public prefix; every row that names it is pointed at the
 * copy; and only then are the old objects deleted. A failure leaves the row on
 * the old prefix, which is still served signed, and the next start tries it
 * again.
 *
 * Left alone: a catalog picture, which many rows share and which is
 * immutable; a prefix that is already public; and an object the read-only
 * source serves, which this server cannot write. The process that owns that
 * bucket moves those.
 */

/** Every column that holds a picture prefix, and the kind it was stored as. */
const PICTURE_COLUMNS: ReadonlyArray<{
  table: keyof Database
  column: string
  kind: ImageKind
}> = [
  { table: 'users', column: 'avatar_path', kind: 'user' },
  { table: 'leagues', column: 'logo_path', kind: 'league' },
  { table: 'seasons', column: 'logo_path', kind: 'league' },
  { table: 'teams', column: 'logo_path', kind: 'team' },
  { table: 'venues', column: 'photo_path', kind: 'venue' },
  { table: 'venue_fields', column: 'photo_path', kind: 'field' }
]

const KINDS: readonly ImageKind[] = ['team', 'league', 'user', 'venue', 'field']

export interface Republished {
  /** Prefixes moved to a public one. */
  moved: number
  /** Prefixes left as they are: catalog, already public, or read-only. */
  skipped: number
  /** Prefixes whose copy failed, left on the old prefix. */
  failed: number
}

export async function republishOwnedImages(
  db: Kysely<Database>,
  space: SpaceSettings,
  log: (message: string) => void = () => undefined
): Promise<Republished> {
  const result: Republished = { moved: 0, skipped: 0, failed: 0 }
  if (!spaceConfigured(space)) return result

  // One move per prefix, however many rows share it: a second copy of the
  // same objects would find them already deleted.
  const kinds = new Map<string, ImageKind>()
  for (const { table, column, kind } of PICTURE_COLUMNS) {
    const rows = await sql<{ prefix: string }>`
      select distinct ${sql.ref(column)} as prefix from ${sql.table(table)}
      where ${sql.ref(column)} is not null and ${sql.ref(column)} <> ''
    `.execute(db)
    for (const { prefix } of rows.rows)
      if (!kinds.has(prefix)) kinds.set(prefix, kindOf(prefix) ?? kind)
  }

  for (const [prefix, kind] of kinds) {
    const sizes = sizesFor(kind)
    if (
      prefix.startsWith('images/catalog/') ||
      isPublicImagePrefix(prefix) ||
      sizes.some(size => isReadOnlySourceKey(space, imageKey(prefix, size)))
    ) {
      result.skipped += 1
      continue
    }
    const next = imagePathPrefix(kind)
    try {
      for (const size of sizes)
        await copyObject({
          space,
          sourceKey: imageKey(prefix, size),
          key: imageKey(next, size),
          contentType: 'image/png',
          // A rendered picture is far under CopyObject's 5 GiB limit.
          size: 0,
          acl: 'public-read'
        })
    } catch (error) {
      result.failed += 1
      log(`republishing ${prefix}: ${String(error)}`)
      continue
    }
    for (const { table, column } of PICTURE_COLUMNS)
      await sql`
        update ${sql.table(table)} set ${sql.ref(column)} = ${next}
        where ${sql.ref(column)} = ${prefix}
      `.execute(db)
    result.moved += 1
    // The rows name the copy now; an old object left behind is only waste.
    for (const size of sizes)
      await deleteObject({ space, key: imageKey(prefix, size) }).catch(
        (error: unknown) => {
          log(`deleting ${imageKey(prefix, size)}: ${String(error)}`)
        }
      )
  }
  return result
}

/** The kind an old `images/<kind>/<entity>/<hash>` prefix was stored as. */
function kindOf(prefix: string): ImageKind | undefined {
  const [root, named] = prefix.split('/')
  return root === 'images' ? KINDS.find(kind => kind === named) : undefined
}
