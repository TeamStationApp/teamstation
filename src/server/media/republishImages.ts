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
 * copy in one transaction, which also records the old prefix as retired; and
 * the old objects are deleted only by a start at least `RETIRED_GRACE_MS`
 * later, so a process still on the previous build, or a URL it signed from a
 * row it read before the move, keeps working until then. A copy that fails
 * leaves the row on the old prefix, which is still served signed; the next
 * start tries it again, unless the Space said the object does not exist,
 * which no retry changes: that prefix is remembered and left alone.
 *
 * Left alone: a catalog picture, which many rows share and which is
 * immutable; a prefix that is already public; an object the read-only
 * source serves, which this server cannot write; and a prefix remembered as
 * missing. The process that owns that bucket moves the read-only ones.
 *
 * What is remembered between starts lives in `system_settings`, one row per
 * prefix: `pictures.retiredPrefix.<prefix>` (its kind and when it was
 * retired) and `pictures.missingPrefix.<prefix>` (the error and when).
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

/** The settings rows a retired prefix and a missing one are kept under. */
export const RETIRED_PREFIX = 'pictures.retiredPrefix.'
export const MISSING_PREFIX = 'pictures.missingPrefix.'

/**
 * How long a retired prefix's objects outlive the move: longer than a deploy
 * overlaps the previous build, and than a URL signed from an old row lasts.
 */
export const RETIRED_GRACE_MS = 24 * 60 * 60 * 1000

/** How many prefixes are copied at once. */
const MOVES_AT_ONCE = 4

export interface Republished {
  /** Prefixes moved to a public one. */
  moved: number
  /** Prefixes left as they are: catalog, already public, read-only or missing. */
  skipped: number
  /** Prefixes whose copy or row update failed, left on the old prefix. */
  failed: number
}

export async function republishOwnedImages(
  db: Kysely<Database>,
  space: SpaceSettings,
  log: (message: string) => void = () => undefined,
  options: { now?: () => number; movesAtOnce?: number } = {}
): Promise<Republished> {
  const result: Republished = { moved: 0, skipped: 0, failed: 0 }
  if (!spaceConfigured(space)) return result
  const now = options.now ?? Date.now

  await deleteRetired(db, space, now(), log)

  // One move per prefix, however many rows share it: a second copy of the
  // same objects would find them already moved.
  const kinds = new Map<string, ImageKind>()
  for (const { table, column, kind } of PICTURE_COLUMNS) {
    const rows = await sql<{ prefix: string }>`
      select distinct ${sql.ref(column)} as prefix from ${sql.table(table)}
      where ${sql.ref(column)} is not null and ${sql.ref(column)} <> ''
    `.execute(db)
    for (const { prefix } of rows.rows)
      if (!kinds.has(prefix)) kinds.set(prefix, kindOf(prefix) ?? kind)
  }
  const missing = new Set(
    (await remembered(db, MISSING_PREFIX)).map(({ prefix }) => prefix)
  )

  const moves: Array<() => Promise<void>> = []
  for (const [prefix, kind] of kinds) {
    const sizes = sizesFor(kind)
    if (
      prefix.startsWith('images/catalog/') ||
      isPublicImagePrefix(prefix) ||
      missing.has(prefix) ||
      sizes.some(size => isReadOnlySourceKey(space, imageKey(prefix, size)))
    ) {
      result.skipped += 1
      continue
    }
    moves.push(async () => {
      const outcome = await move(db, space, prefix, kind, now, log)
      result[outcome] += 1
    })
  }
  await inPool(moves, options.movesAtOnce ?? MOVES_AT_ONCE)
  return result
}

/**
 * Copies one old prefix to a new public one and points every row at it, or
 * leaves it where it was.
 */
async function move(
  db: Kysely<Database>,
  space: SpaceSettings,
  prefix: string,
  kind: ImageKind,
  now: () => number,
  log: (message: string) => void
): Promise<'moved' | 'failed'> {
  const sizes = sizesFor(kind)
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
    log(`republishing ${prefix}: ${String(error)}`)
    // The Space has no such object: every later start would fail the same
    // way, so this one is remembered and not tried again.
    if (/NoSuchKey|answered 404/.test(String(error)))
      await remember(db, MISSING_PREFIX, prefix, {
        error: String(error).slice(0, 300),
        at: now()
      }).catch((failure: unknown) => {
        log(`remembering ${prefix}: ${String(failure)}`)
      })
    return 'failed'
  }
  try {
    // Every row moves at once, and the old prefix is retired with them.
    await db.transaction().execute(async trx => {
      for (const { table, column } of PICTURE_COLUMNS)
        await sql`
          update ${sql.table(table)} set ${sql.ref(column)} = ${next}
          where ${sql.ref(column)} = ${prefix}
        `.execute(trx)
      await remember(trx, RETIRED_PREFIX, prefix, { kind, at: now() })
    })
  } catch (error) {
    log(`republishing ${prefix}: ${String(error)}`)
    return 'failed'
  }
  return 'moved'
}

/**
 * Deletes the objects of every prefix retired at least `RETIRED_GRACE_MS`
 * before `now`, and forgets it. A prefix a row names again is forgotten and
 * kept; a delete that fails is logged and tried again by the next start.
 */
async function deleteRetired(
  db: Kysely<Database>,
  space: SpaceSettings,
  now: number,
  log: (message: string) => void
): Promise<void> {
  for (const { prefix, value } of await remembered(db, RETIRED_PREFIX)) {
    const { at, kind } = value as { at?: unknown; kind?: unknown }
    if (typeof at === 'number' && now - at < RETIRED_GRACE_MS) continue
    const known = KINDS.find(each => each === kind) ?? kindOf(prefix)
    let deleted = true
    if (known != null && !(await named(db, prefix)))
      for (const size of sizesFor(known))
        await deleteObject({ space, key: imageKey(prefix, size) }).catch(
          (error: unknown) => {
            deleted = false
            log(`deleting ${imageKey(prefix, size)}: ${String(error)}`)
          }
        )
    if (deleted)
      await db
        .deleteFrom('system_settings')
        .where('key', '=', `${RETIRED_PREFIX}${prefix}`)
        .execute()
  }
}

/** The prefixes remembered under `under`, with what was recorded of each. */
async function remembered(
  db: Kysely<Database>,
  under: string
): Promise<Array<{ prefix: string; value: unknown }>> {
  const rows = await db
    .selectFrom('system_settings')
    .select(['key', 'value'])
    .where('key', 'like', `${under}%`)
    .execute()
  return rows.map(({ key, value }) => ({
    prefix: key.slice(under.length),
    value
  }))
}

async function remember(
  db: Kysely<Database>,
  under: string,
  prefix: string,
  value: Record<string, string | number>
): Promise<void> {
  await db
    .insertInto('system_settings')
    .values({ key: `${under}${prefix}`, value: JSON.stringify(value) })
    .onConflict(oc =>
      oc.column('key').doUpdateSet({
        value: JSON.stringify(value),
        updated_at: new Date()
      })
    )
    .execute()
}

/** Runs `tasks`, at most `size` at a time. */
async function inPool(
  tasks: ReadonlyArray<() => Promise<void>>,
  size: number
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < tasks.length) await tasks[next++]()
  }
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, worker)
  )
}

/**
 * Whether `work` settles within `ms`. It goes on either way: the caller only
 * stops waiting for it.
 */
export async function settlesWithin(
  work: Promise<unknown>,
  ms: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>(resolve => {
    timer = setTimeout(() => {
      resolve(false)
    }, ms)
  })
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true
      ),
      late
    ])
  } finally {
    clearTimeout(timer)
  }
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
