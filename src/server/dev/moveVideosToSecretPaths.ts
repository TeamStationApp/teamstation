import { readFile } from 'node:fs/promises'

import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { copyObject } from '../media/images'
import { spaceConfigured, type SpaceSettings } from '../media/spacesHls'
import {
  contentTypeFor,
  deleteSpaceKeys,
  listSpaceObjectEntries,
  type SpaceObjectEntry
} from '../media/spacesVideo'
import {
  isSecretKeyOf,
  isSpaceSecret,
  newSpaceSecret,
  oldVideoPrefix,
  uploadHeadersFor,
  videoPrefix,
  withoutSecrets
} from '../media/videoPrefix'

/**
 * Moves every existing video's media from `videos/<id>/` to its secret path,
 * `videos/<id>-<secret>/`, and gives every other video a secret.
 *
 * Run from the workstation after an environment's deploy, while no game is
 * live: `--dry-run` first, then the real run. Until it reaches a video, that
 * video plays from its old path with signed URLs, so there is no hurry.
 *
 * For each row, whatever its `storage` (a live recording from before the
 * deploy is under the old path too), with one list request of its old prefix:
 *
 * 1. Its secret: the row's; or one a stopped run already copied under; or a
 *    new one.
 * 2. Each object under `videos/<id>/` apart from `stills/` is copied to the
 *    secret path with its kind's ACL and cache header, unless a copy of that
 *    length is already there.
 * 3. Each copy's length is checked, by listing the secret path.
 * 4. Only then is `space_secret` set.
 * 5. Last, the copied objects are deleted from the old prefix. Stills stay.
 *
 * So it is idempotent: a second run changes nothing, and a run stopped after
 * the copies finishes by deleting the old objects. A row with nothing under
 * its old prefix only gets a secret. A read-only-source video, whose objects
 * are another bucket's, is left alone, secret and all; so is a live
 * recording the ingest still holds: its stream open, or ended with its close
 * not yet verified. A later run moves it.
 */

/** Copies in flight at once for one video. */
const COPIES_IN_FLIGHT = 8

export interface MoveOptions {
  db: Kysely<Database>
  space: SpaceSettings
  /** Lists and reports, and writes nothing. */
  dryRun?: boolean
  /** At most this many videos are moved (rows only given a secret not counted). */
  limit?: number
  /** Only this video. */
  videoId?: string
  /** Rows read at a time. */
  batchSize?: number
  /** For a test: the size over which a copy goes as a multipart upload. */
  copyLimitBytes?: number
  partSize?: number
  log?: (line: string) => void
}

export interface MoveReport {
  /** Videos whose objects were copied (or, in a dry run, would be). */
  moved: string[]
  /** Videos whose copies were already there, and whose old objects went. */
  finished: string[]
  /** Videos with nothing under their old prefix that were given a secret. */
  secretOnly: string[]
  /** Read-only-source videos, and videos being published to. */
  skipped: string[]
}

/** A secret, shortened for a log: the whole of it is a capability. */
export function maskedPrefix(videoId: string, secret: string): string {
  return withoutSecrets(videoPrefix({ id: videoId, spaceSecret: secret }))
}

export async function moveVideosToSecretPaths(
  options: MoveOptions
): Promise<MoveReport> {
  const { db, space, dryRun = false } = options
  const log =
    options.log ??
    ((line: string) => {
      console.log(line)
    })
  if (!spaceConfigured(space)) throw new Error('No Space is configured')
  const report: MoveReport = {
    moved: [],
    finished: [],
    secretOnly: [],
    skipped: []
  }
  const batchSize = options.batchSize ?? 100
  let after = ''
  for (;;) {
    let query = db
      .selectFrom('videos')
      .select(['id', 'space_secret', 'kind', 'spaces_verified_at'])
      .where('id', '>', after)
      .orderBy('id')
      .limit(batchSize)
    if (options.videoId != null) query = query.where('id', '=', options.videoId)
    const rows = await query.execute()
    if (rows.length === 0) break
    after = rows[rows.length - 1].id
    // Any stream still open, not only one being published to: inside its
    // reconnect grace the ingest holds an origin on the old prefix, which
    // would write there again when the camera came back.
    const open = new Set(
      (
        await db
          .selectFrom('live_streams')
          .select('video_id')
          .where(
            'video_id',
            'in',
            rows.map(row => row.id)
          )
          .where('ended_at', 'is', null)
          .execute()
      ).map(row => row.video_id)
    )
    for (const row of rows) {
      if (
        options.limit != null &&
        report.moved.length + report.finished.length >= options.limit
      )
        return report
      // A live recording whose stream ended is still the ingest's until its
      // close is verified (or, with no Space then, until it is put away): its
      // origin finishes it on the path it started on.
      const unfinished = row.kind === 'live' && row.spaces_verified_at == null
      const why = isReadOnlySource(space, row.id)
        ? 'read-only source'
        : open.has(row.id)
          ? 'its stream is open'
          : unfinished
            ? 'its recording is not closed yet'
            : undefined
      if (why != null) {
        report.skipped.push(row.id)
        log(`skip ${row.id}: ${why}`)
        continue
      }
      await moveOne(options, row.id, row.space_secret, dryRun, report, log)
    }
    if (rows.length < batchSize) break
  }
  return report
}

/** A video whose objects the read-only source names lives in another bucket. */
function isReadOnlySource(space: SpaceSettings, videoId: string): boolean {
  const prefix = oldVideoPrefix(videoId)
  return space.readOnlySource?.keys.some(key => key.startsWith(prefix)) ?? false
}

async function moveOne(
  options: MoveOptions,
  videoId: string,
  held: string | null,
  dryRun: boolean,
  report: MoveReport,
  log: (line: string) => void
): Promise<void> {
  const { db, space } = options
  const old = oldVideoPrefix(videoId)
  const objects = (await listSpaceObjectEntries(space, old)).filter(
    entry => !entry.key.startsWith(`${old}stills/`)
  )
  if (objects.length === 0) {
    if (held != null) return
    report.secretOnly.push(videoId)
    if (dryRun) {
      log(`would give ${videoId} a secret (nothing under ${old})`)
      return
    }
    await setSecret(db, videoId, newSpaceSecret())
    log(`gave ${videoId} a secret (nothing under ${old})`)
    return
  }

  const secret =
    held ?? (await copiedSecret(space, videoId)) ?? newSpaceSecret()
  const prefix = videoPrefix({ id: videoId, spaceSecret: secret })
  const there = new Map(
    (await listSpaceObjectEntries(space, prefix)).map(entry => [
      entry.key,
      entry
    ])
  )
  const target = (entry: SpaceObjectEntry): string =>
    prefix + entry.key.slice(old.length)
  const missing = objects.filter(
    entry => there.get(target(entry))?.size !== entry.size
  )
  const bytes = objects.reduce((sum, entry) => sum + entry.size, 0)
  const where = maskedPrefix(videoId, secret)
  if (dryRun) {
    if (missing.length === 0) {
      report.finished.push(videoId)
      log(
        `would finish ${videoId}: ${objects.length} objects already at ${where}`
      )
    } else {
      report.moved.push(videoId)
      log(
        `would move ${videoId}: ${objects.length} objects, ${bytes} bytes, from ${old} to ${where}`
      )
    }
    return
  }

  // A live recording from before secrets is two thousand pieces: a few
  // copies at a time, in the Space, never through this machine.
  let next = 0
  await Promise.all(
    Array.from(
      { length: Math.min(COPIES_IN_FLIGHT, missing.length) },
      async () => {
        while (next < missing.length) {
          const entry = missing[next++]
          const name = entry.key.slice(old.length)
          await copyObject({
            space,
            sourceKey: entry.key,
            key: target(entry),
            contentType: contentTypeFor(name),
            size: entry.size,
            copyLimitBytes: options.copyLimitBytes,
            partSize: options.partSize,
            ...uploadHeadersFor(secret, name.split('/').at(-1) ?? name)
          })
        }
      }
    )
  )
  // Every copy's length, from one listing, before the row points there.
  const copied = new Map(
    (await listSpaceObjectEntries(space, prefix)).map(entry => [
      entry.key,
      entry.size
    ])
  )
  for (const entry of objects)
    if (copied.get(target(entry)) !== entry.size)
      throw new Error(
        `${target(entry).replace(prefix, where)} is ${copied.get(target(entry)) ?? 'missing'}, not ${entry.size} bytes`
      )
  if (held == null) await setSecret(db, videoId, secret)
  await deleteSpaceKeys(
    space,
    objects.map(entry => entry.key)
  )
  if (missing.length === 0) report.finished.push(videoId)
  else report.moved.push(videoId)
  log(
    `${missing.length === 0 ? 'finished' : 'moved'} ${videoId}: ${objects.length} objects, ${bytes} bytes, to ${where}`
  )
}

/**
 * The secret a stopped run already copied this video under, so finishing it
 * reuses those copies rather than making a second set.
 */
async function copiedSecret(
  space: SpaceSettings,
  videoId: string
): Promise<string | undefined> {
  const secrets = new Set<string>()
  for (const entry of await listSpaceObjectEntries(space, `videos/${videoId}-`))
    if (isSecretKeyOf(videoId, entry.key))
      secrets.add(entry.key.split('/')[1].slice(videoId.length + 1))
  return [...secrets].sort()[0]
}

async function setSecret(
  db: Kysely<Database>,
  videoId: string,
  secret: string
): Promise<void> {
  if (!isSpaceSecret(secret)) throw new Error('Invalid secret')
  const set = await db
    .updateTable('videos')
    .set({ space_secret: secret })
    .where('id', '=', videoId)
    .where('space_secret', 'is', null)
    .executeTakeFirst()
  if (set.numUpdatedRows === 0n)
    throw new Error(`${videoId} was given another secret meanwhile`)
}

export interface MoveArgs {
  dryRun: boolean
  limit?: number
  videoId?: string
  config?: string
}

export function parseMoveArgs(argv: readonly string[]): MoveArgs {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag)
    if (at === -1) return undefined
    const next = argv[at + 1]
    if (next == null || next.startsWith('--'))
      throw new Error(`${flag} needs a value`)
    return next
  }
  const known = new Set(['--dry-run', '--limit', '--video', '--config'])
  for (const [index, arg] of argv.entries())
    if (
      arg.startsWith('--') &&
      !known.has(arg) &&
      !['--limit', '--video', '--config'].includes(argv[index - 1] ?? '')
    )
      throw new Error(`Unknown flag ${arg}`)
  const limit = value('--limit')
  if (limit != null && !/^[1-9]\d*$/.test(limit))
    throw new Error('--limit takes a positive whole number')
  return {
    dryRun: argv.includes('--dry-run'),
    limit: limit == null ? undefined : Number(limit),
    videoId: value('--video'),
    config: value('--config')
  }
}

/* c8 ignore start: the script itself */
async function main(): Promise<void> {
  const args = parseMoveArgs(process.argv.slice(2))
  // Read here, not at the top: importing the configuration reads
  // `./serverConfig.json`, which the tests of this module must not.
  const { asServerConfig } = await import('../serverConfigSchema')
  const config =
    args.config == null
      ? (await import('../serverConfig')).serverConfig
      : asServerConfig(JSON.parse(await readFile(args.config, 'utf8')))
  const { makeDatabase } = await import('../db/database')
  const db = makeDatabase(config.databaseUrl)
  try {
    const report = await moveVideosToSecretPaths({
      db,
      space: config.space,
      dryRun: args.dryRun,
      limit: args.limit,
      videoId: args.videoId
    })
    console.log(
      `${args.dryRun ? 'dry run: ' : ''}${report.moved.length} moved, ` +
        `${report.finished.length} finished, ${report.secretOnly.length} given a secret, ` +
        `${report.skipped.length} skipped`
    )
  } finally {
    await db.destroy()
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
/* c8 ignore stop */
