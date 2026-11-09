import { type Kysely, sql } from 'kysely'

import { afterCommit } from '../db/atomic'
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

/**
 * Deletes every size of the pictures no row names any more: the ones a write
 * has just replaced or emptied. Left alone: a catalog picture, an object the
 * read-only source serves, a prefix of no kind this server stores, and a
 * prefix another row still names. A delete that fails is logged; the row has
 * already moved on.
 */
export async function releasePictures(
  db: Kysely<Database>,
  space: SpaceSettings,
  prefixes: Iterable<string | null | undefined>,
  log: (message: string) => void = message => {
    console.error(`pictures: ${message}`)
  }
): Promise<number> {
  if (!spaceConfigured(space)) return 0
  let released = 0
  for (const prefix of new Set(prefixes)) {
    if (prefix == null || prefix.startsWith('images/catalog/')) continue
    const kind = kindOf(prefix)
    if (kind == null) continue
    const sizes = sizesFor(kind)
    if (sizes.some(size => isReadOnlySourceKey(space, imageKey(prefix, size))))
      continue
    if (await named(db, prefix)) continue
    for (const size of sizes)
      await deleteObject({ space, key: imageKey(prefix, size) }).catch(
        (error: unknown) => {
          log(`deleting ${imageKey(prefix, size)}: ${String(error)}`)
        }
      )
    released += 1
  }
  return released
}

/**
 * Releases `prefix`, which a write in `db` has just replaced, once that
 * write is committed (`afterCommit`): a rolled back write still names it.
 */
export async function releaseReplacedPicture(
  db: Kysely<Database>,
  space: SpaceSettings,
  prefix: string | null | undefined
): Promise<void> {
  if (prefix == null || prefix === '') return
  await afterCommit(db, async committed => {
    // The write has committed whatever happens here: a failure is only
    // waste in the Space, never the request's.
    await releasePictures(committed, space, [prefix]).catch(
      (error: unknown) => {
        console.error(`pictures: releasing ${prefix}: ${String(error)}`)
      }
    )
  })
}

/** Whether any row names `prefix` as its picture. */
async function named(db: Kysely<Database>, prefix: string): Promise<boolean> {
  for (const { table, column } of PICTURE_COLUMNS) {
    const rows = await sql`
      select 1 from ${sql.table(table)} where ${sql.ref(column)} = ${prefix}
      limit 1
    `.execute(db)
    if (rows.rows.length > 0) return true
  }
  return false
}
