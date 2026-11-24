import { readFile } from 'node:fs/promises'

import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { putObject, SpaceRefusal } from '../media/images'
import { presignGetUrl } from '../media/presign'
import {
  PIECE_TIMEOUT_MS,
  slicePlan,
  sliceSpaceObject
} from '../media/sliceRecording'
import {
  spaceConfigured,
  spaceKey,
  type SpaceSettings
} from '../media/spacesHls'
import {
  contentTypeFor,
  deleteSpaceKeys,
  listSpaceObjectEntries,
  listSpaceObjects,
  secretKeysOf,
  withSpaceRetry
} from '../media/spacesVideo'
import {
  newSpaceSecret,
  oldVideoPrefix,
  uploadHeadersFor,
  videoPrefix,
  withoutSecrets
} from '../media/videoPrefix'
import { holdReason } from './moveVideosToSecretPaths'

/**
 * Repackages every recording in the Space that is still one `video.mp4` into
 * segment objects, and later deletes what it left behind.
 *
 * A range deep inside a multi-gigabyte file is a cache miss the Spaces CDN can
 * sit on for over a minute, so a seek into such a recording hangs. Its
 * playlist already says where every fragment is, so each range is copied to
 * an object of its own, in the Space, with no FFmpeg and no local disk; the
 * bytes and the timeline are exactly the old ones (`sliceRecording.ts`).
 *
 *   node lib/server/dev/segmentSpaceVideos.js [--dry-run] [--video <id>] [--limit <n>] [--delete-old]
 *
 * Every `storage = 'spaces'` row, visible videos first, apart from
 * read-only-source videos and live recordings the ingest still holds (the
 * rule `moveVideosToSecretPaths` uses). A row whose prefix holds a
 * `video.mp4` is single-file, and each is done in turn:
 *
 * 1. Its playlists read, and a `slicePlan` made of `video.m3u8`.
 * 2. A new secret, and every piece copied to `videos/<id>-<new>/`, then the
 *    rewritten `video.m3u8` and the unchanged `master.m3u8`.
 * 3. The new prefix checked: every name and length, by one listing, and the
 *    playlists read back byte for byte.
 * 4. Only then `space_secret` and `size_bytes` set, in one statement that
 *    also requires the old secret. A player already holding the old playlist
 *    plays on from the old objects; the next to ask is given the new one.
 *
 * Stills, under `videos/<id>/stills/`, are not touched.
 *
 * `--delete-old`, run the next day while no game is live, deletes for each
 * row on a segmented prefix every object under its other prefixes:
 * `videos/<id>/` apart from `stills/`, and `videos/<id>-<other secret>/`.
 *
 * Both are idempotent. A run that stops part way leaves the row on its old,
 * working prefix; the next starts again under a fresh secret, and
 * `--delete-old` removes the abandoned one. A secret is never printed.
 */

export interface SegmentOptions {
  db: Kysely<Database>
  space: SpaceSettings
  /** Reports, and writes nothing. */
  dryRun?: boolean
  /** Deletes the objects repackaged videos left behind, instead of repackaging. */
  deleteOld?: boolean
  /** At most this many videos are repackaged, or cleaned. */
  limit?: number
  /** Only this video. */
  videoId?: string
  log?: (line: string) => void
  fetch?: typeof fetch
}

export interface SegmentReport {
  /** Repackaged, or in a dry run would be. */
  repackaged: string[]
  /** Already segments. */
  segmented: string[]
  /** Old prefixes deleted, or in a dry run would be. */
  cleaned: string[]
  /** Read-only-source videos, and recordings the ingest still holds. */
  skipped: string[]
  /** Failed, with the row left where it was. */
  failed: string[]
}

/**
 * Whether a prefix holds a whole segmented recording: its master, a media
 * playlist, an init segment and a segment. Anything less, an empty prefix
 * above all, is not one, and nothing is deleted on the strength of it.
 */
export function isSegmentedPrefix(names: readonly string[]): boolean {
  return (
    names.includes('master.m3u8') &&
    (names.includes('video.m3u8') || names.includes('index.m3u8')) &&
    names.some(name => /^init\d*\.mp4$/.test(name)) &&
    names.some(name => /^seg\d{6,}\.m4s$/.test(name))
  )
}

/** Where a video's media is, its secret masked. */
function masked(videoId: string, secret: string | null): string {
  return withoutSecrets(videoPrefix({ id: videoId, spaceSecret: secret }))
}

export async function segmentSpaceVideos(
  options: SegmentOptions
): Promise<SegmentReport> {
  const { db, space } = options
  const log =
    options.log ??
    ((line: string) => {
      console.log(line)
    })
  if (!spaceConfigured(space)) throw new Error('No Space is configured')
  const report: SegmentReport = {
    repackaged: [],
    segmented: [],
    cleaned: [],
    skipped: [],
    failed: []
  }
  let query = db
    .selectFrom('videos')
    .select(['id', 'space_secret', 'kind', 'spaces_verified_at', 'hidden'])
    .where('storage', '=', 'spaces')
    .orderBy('hidden')
    .orderBy('id')
  if (options.videoId != null) query = query.where('id', '=', options.videoId)
  const rows = await query.execute()
  const open = new Set(
    rows.length === 0
      ? []
      : (
          await db
            .selectFrom('live_streams')
            .select('video_id')
            .where('ended_at', 'is', null)
            .execute()
        ).map(row => row.video_id)
  )

  for (const row of rows) {
    const done = report.repackaged.length + report.cleaned.length
    if (options.limit != null && done >= options.limit) break
    const why = holdReason(space, row, open)
    if (why != null) {
      report.skipped.push(row.id)
      log(`skip ${row.id}: ${why}`)
      continue
    }
    try {
      if (options.deleteOld === true)
        await deleteOld(options, row.id, row.space_secret, report, log)
      else await repackage(options, row.id, row.space_secret, report, log)
    } catch (error) {
      report.failed.push(row.id)
      log(
        `failed ${row.id}: ${withoutSecrets(error instanceof Error ? error.message : String(error))}`
      )
    }
  }
  return report
}

async function readObject(
  options: SegmentOptions,
  key: string
): Promise<Buffer> {
  return await withSpaceRetry(async () => {
    const response = await (options.fetch ?? globalThis.fetch)(
      presignGetUrl({ ...options.space, key, expiresSec: 300 }),
      { signal: AbortSignal.timeout(PIECE_TIMEOUT_MS) }
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new SpaceRefusal(
        `${key} answered ${response.status}`,
        response.status
      )
    }
    return Buffer.from(await response.arrayBuffer())
  })
}

async function repackage(
  options: SegmentOptions,
  videoId: string,
  secret: string | null,
  report: SegmentReport,
  log: (line: string) => void
): Promise<void> {
  const { db, space } = options
  const source = { id: videoId, spaceSecret: secret }
  const prefix = videoPrefix(source)
  const entries = (await listSpaceObjectEntries(space, prefix)).filter(
    entry => !entry.key.startsWith(`${prefix}stills/`)
  )
  const single = entries.find(entry => entry.key === `${prefix}video.mp4`)
  if (single == null) {
    if (
      !isSegmentedPrefix(entries.map(entry => entry.key.slice(prefix.length)))
    ) {
      report.skipped.push(videoId)
      log(`skip ${videoId}: ${masked(videoId, secret)} holds no recording`)
      return
    }
    report.segmented.push(videoId)
    log(`segmented ${videoId}: ${masked(videoId, secret)} has no video.mp4`)
    return
  }
  const media = (await readObject(options, `${prefix}video.m3u8`)).toString(
    'utf8'
  )
  const master = await readObject(options, `${prefix}master.m3u8`)
  const plan = slicePlan(media)
  const playlist = Buffer.from(plan.playlist)
  const bytes = plan.bytes + playlist.length + master.length
  const pieces = plan.pieces.length
  if (options.dryRun === true) {
    report.repackaged.push(videoId)
    log(
      `would repackage ${videoId}: ${pieces} pieces, ${bytes} bytes, from ${masked(videoId, secret)}`
    )
    return
  }

  const target = { id: videoId, spaceSecret: newSpaceSecret() }
  const targetPrefix = videoPrefix(target)
  // A copy that did not come out whole is nobody's: it is a new secret no
  // row will ever name, so it goes now rather than being paid for until a
  // later run of the same video succeeds.
  try {
    await sliceSpaceObject({
      space,
      source,
      target,
      plan,
      objectBytes: single.size,
      fetch: options.fetch
    })
    for (const [name, body] of [
      ['video.m3u8', playlist],
      ['master.m3u8', master]
    ] as const) {
      await withSpaceRetry(async () => {
        await putObject({
          space,
          key: spaceKey(target, name),
          body,
          contentType: contentTypeFor(name),
          signal: AbortSignal.timeout(PIECE_TIMEOUT_MS),
          ...uploadHeadersFor(target.spaceSecret, name)
        })
      })
    }

    // Every piece, by one listing, and the playlists byte for byte.
    const there = new Map(
      (await listSpaceObjectEntries(space, targetPrefix)).map(entry => [
        entry.key.slice(targetPrefix.length),
        entry.size
      ])
    )
    for (const piece of plan.pieces) {
      if (there.get(piece.name) !== piece.length)
        throw new Error(
          `${piece.name} is ${there.get(piece.name) ?? 'missing'} there, not ${piece.length} bytes`
        )
    }
    for (const [name, body] of [
      ['video.m3u8', playlist],
      ['master.m3u8', master]
    ] as const) {
      const back = await readObject(options, `${targetPrefix}${name}`)
      if (!back.equals(body)) throw new Error(`${name} came back different`)
    }
  } catch (error) {
    // The listing too: a copy that failed because the Space is unreachable
    // fails to list as well, and the copy's own error is the one to report.
    await listSpaceObjects(space, targetPrefix)
      .then(async keys => {
        await deleteSpaceKeys(space, keys)
      })
      .catch((cleanup: unknown) => {
        log(`${videoId}: the partial copy was not deleted: ${String(cleanup)}`)
      })
    throw error
  }

  const set = await db
    .updateTable('videos')
    .set({
      space_secret: target.spaceSecret,
      size_bytes: String(bytes),
      updated_at: new Date()
    })
    .where('id', '=', videoId)
    .where(eb =>
      secret == null
        ? eb('space_secret', 'is', null)
        : eb('space_secret', '=', secret)
    )
    .executeTakeFirst()
  if (set.numUpdatedRows === 0n) {
    const still = await db
      .selectFrom('videos')
      .select('id')
      .where('id', '=', videoId)
      .executeTakeFirst()
    if (still == null) {
      // Deleted while it was being copied: its delete took the prefixes that
      // were there then, and nothing will ever visit this one again.
      await deleteSpaceKeys(space, await listSpaceObjects(space, targetPrefix))
      throw new Error('it was deleted meanwhile; the new copy is deleted too')
    }
    throw new Error(
      'its row changed meanwhile; the new copy is left for --delete-old'
    )
  }
  report.repackaged.push(videoId)
  log(
    `repackaged ${videoId}: ${pieces} pieces, ${bytes} bytes, ${masked(videoId, secret)} → ${masked(videoId, target.spaceSecret)}`
  )
}

async function deleteOld(
  options: SegmentOptions,
  videoId: string,
  secret: string | null,
  report: SegmentReport,
  log: (line: string) => void
): Promise<void> {
  const { space } = options
  const current = videoPrefix({ id: videoId, spaceSecret: secret })
  const here = (await listSpaceObjectEntries(space, current)).map(entry =>
    entry.key.slice(current.length)
  )
  // Still a single file, still on the plain path, or a prefix that does not
  // hold the whole recording: nothing else of it may go.
  if (secret == null || !isSegmentedPrefix(here)) return
  const old = oldVideoPrefix(videoId)
  const others = [
    ...(await listSpaceObjectEntries(space, old))
      .map(entry => entry.key)
      .filter(key => !key.startsWith(`${old}stills/`)),
    ...(await secretKeysOf(space, videoId)).filter(
      key => !key.startsWith(current)
    )
  ]
  if (others.length === 0) return
  report.cleaned.push(videoId)
  if (options.dryRun === true) {
    log(
      `would delete ${others.length} old objects of ${videoId}, keeping ${masked(videoId, secret)}`
    )
    return
  }
  await deleteSpaceKeys(space, others)
  log(
    `deleted ${others.length} old objects of ${videoId}, keeping ${masked(videoId, secret)}`
  )
}

export interface SegmentArgs {
  dryRun: boolean
  deleteOld: boolean
  limit?: number
  videoId?: string
  config?: string
}

export function parseSegmentArgs(argv: readonly string[]): SegmentArgs {
  const valued = ['--limit', '--video', '--config']
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag)
    if (at === -1) return undefined
    const next = argv[at + 1]
    if (next == null || next.startsWith('--'))
      throw new Error(`${flag} needs a value`)
    return next
  }
  const known = new Set(['--dry-run', '--delete-old', ...valued])
  for (const [index, arg] of argv.entries()) {
    if (valued.includes(argv[index - 1] ?? '')) continue
    if (!arg.startsWith('--'))
      // A bare id would otherwise be ignored, and the run would go over every
      // video in the Space: name it with --video.
      throw new Error(`Unexpected argument ${arg}: name a video with --video`)
    if (!known.has(arg)) throw new Error(`Unknown flag ${arg}`)
  }
  const limit = value('--limit')
  if (limit != null && !/^[1-9]\d*$/.test(limit))
    throw new Error('--limit takes a positive whole number')
  return {
    dryRun: argv.includes('--dry-run'),
    deleteOld: argv.includes('--delete-old'),
    limit: limit == null ? undefined : Number(limit),
    videoId: value('--video'),
    config: value('--config')
  }
}

/** The last line of a run. */
export function summary(report: SegmentReport, args: SegmentArgs): string {
  const prefix = args.dryRun ? 'dry run: ' : ''
  return args.deleteOld
    ? `${prefix}${report.cleaned.length} cleaned, ${report.skipped.length} skipped, ${report.failed.length} failed`
    : `${prefix}${report.repackaged.length} repackaged, ${report.segmented.length} already segments, ` +
        `${report.skipped.length} skipped, ${report.failed.length} failed`
}

/* c8 ignore start: the script itself */
async function main(): Promise<void> {
  const args = parseSegmentArgs(process.argv.slice(2))
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
    const report = await segmentSpaceVideos({
      db,
      space: config.space,
      dryRun: args.dryRun,
      deleteOld: args.deleteOld,
      limit: args.limit,
      videoId: args.videoId
    })
    console.log(summary(report, args))
    if (report.failed.length > 0) process.exitCode = 1
  } finally {
    await db.destroy()
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? withoutSecrets(error.message) : error
    )
    process.exit(1)
  })
}
/* c8 ignore stop */
