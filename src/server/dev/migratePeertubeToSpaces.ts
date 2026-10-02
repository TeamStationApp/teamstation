import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeDatabase } from '../db/database'
import {
  MASTER_PLAYLIST,
  MEDIA_PLAYLIST,
  remuxToHls,
  VIDEO_FILE
} from '../media/ffmpeg'
import { probeVideoFile, tagFor } from '../media/ingestFile'
import { locateVideoFile } from '../media/locations'
import { spaceConfigured } from '../media/spacesHls'
import {
  uploadVideoDirectory,
  verifyVideoDirectory
} from '../media/spacesVideo'
import { serverConfig } from '../serverConfig'
import { slotOf, type VideoRow } from './auditVideos'

/**
 * Copy a PeerTube recording onto the Space without minting a new video.
 *
 * The camera import put 1st / 3rd / home on Spaces and left every primary
 * (and a few lives with nothing else to stand in for them) on the droplet.
 * Playback still goes through PeerTube for those rows. This remuxes the
 * fragmented MP4 that is already there — no re-encode — uploads it under the
 * **same id**, and flips `storage` to `spaces`. Highlights, the four-up
 * Primary track, and the game attachment stay put.
 *
 * Multi-angle composites stay on the droplet. A live moves only when that
 * game has no primary, or — if the live is attached to no game — when no
 * primary starts within fifteen minutes of it.
 *
 *   npm run migrate-peertube -- --dry-run
 *   npm run migrate-peertube -- --skip 9618e1b8-58e6-4fbf-99f1-e343669b556b
 *
 * It is safe to run twice: a row already on Spaces is skipped, a failure
 * leaves the PeerTube directory alone, and the next run picks up where this
 * one stopped. One video at a time.
 *
 * Run it on the droplet. The files are there, and the remux of an 18 GB
 * primary needs the 100 GB disk at `/mnt/teamstation`, not the root volume.
 */

/** Same game, or an unattached live whose clock is this close to a primary. */
export const EQUIVALENT_PRIMARY_MS = 15 * 60 * 1000

/**
 * How long the PeerTube files stay after the Space has them.
 *
 * The live sweep deletes `work/videos/<id>` after this, not the PeerTube
 * tree, so setting the deadline here does not remove the original. It is
 * the same grace a finished live gets, and it is what marks the row as
 * having been handed off.
 */
const LOCAL_GRACE_MS = 6 * 3_600_000

/** Remux output. `/mnt/teamstation` has the room; `/tmp` and `workDir` do not. */
const REMOTE_WORK = '/mnt/teamstation/work/peertube-migrate'

export interface LibraryVideo {
  id: string
  title: string
  kind: string
  storage: 'peertube' | 'local' | 'spaces'
  gameId: string | null
  startAt: Date | null
  startAtSource: string | null
  numCameras: number
}

export type MoveAction = 'migrate' | 'skip'

export interface MoveDecision {
  action: MoveAction
  reason: string
}

function asRow(video: LibraryVideo): VideoRow {
  return {
    id: video.id,
    title: video.title,
    kind: video.kind,
    status: 'ready',
    numCameras: video.numCameras,
    startAtSource: video.startAtSource,
    durationSec: null,
    startAt: video.startAt
  }
}

function isSkippedId(id: string, skipIds: ReadonlySet<string>): boolean {
  for (const skip of skipIds) {
    if (skip === '') continue
    if (id === skip) return true
    if (skip.length >= 8 && id.startsWith(skip)) return true
  }
  return false
}

function nearestPrimary(
  live: LibraryVideo,
  primaries: LibraryVideo[]
): { primary: LibraryVideo; delta: number } | null {
  if (live.startAt == null) return null
  let best: { primary: LibraryVideo; delta: number } | null = null
  const liveAt = live.startAt.getTime()
  for (const primary of primaries) {
    if (primary.startAt == null) continue
    const delta = Math.abs(liveAt - primary.startAt.getTime())
    if (best == null || delta < best.delta) best = { primary, delta }
  }
  return best
}

/**
 * Whether this row should be copied to the Space.
 *
 * Classified with the same `slotOf` the audit uses, so a title the audit
 * called a primary is a primary here, and a composite called `raw` /
 * `combined` / `- Raw Videos` is never copied.
 */
export function moveDecision(
  video: LibraryVideo,
  library: LibraryVideo[],
  skipIds: ReadonlySet<string> = new Set()
): MoveDecision {
  if (isSkippedId(video.id, skipIds)) {
    return { action: 'skip', reason: 'listed in --skip' }
  }
  if (video.storage === 'spaces') {
    return { action: 'skip', reason: 'already on Spaces' }
  }

  const { slot } = slotOf(asRow(video))
  if (slot === 'multiAngle') {
    return { action: 'skip', reason: 'multi-angle — never migrate' }
  }
  if (slot === 'other') {
    return {
      action: 'skip',
      reason: 'partial — not a primary, and not a full live'
    }
  }
  if (slot === 'first' || slot === 'third' || slot === 'home') {
    return { action: 'skip', reason: 'camera — already the Spaces import' }
  }

  const primaries = library.filter(one => slotOf(asRow(one)).slot === 'main')

  if (slot === 'live') {
    if (video.gameId != null) {
      const onGame = primaries.find(one => one.gameId === video.gameId)
      if (onGame != null) {
        return {
          action: 'skip',
          reason: `live — game already has primary \`${onGame.title}\``
        }
      }
    } else {
      const near = nearestPrimary(video, primaries)
      if (near != null && near.delta <= EQUIVALENT_PRIMARY_MS) {
        return {
          action: 'skip',
          reason:
            `live — unattached but start is ${Math.round(near.delta / 1000)}s ` +
            `from primary \`${near.primary.title}\``
        }
      }
    }
    return { action: 'migrate', reason: 'live with no equivalent primary' }
  }

  if (slot === 'main') {
    return { action: 'migrate', reason: 'primary still on PeerTube' }
  }

  return { action: 'skip', reason: 'unclassified slot' }
}

interface Args {
  dryRun: boolean
  skipIds: Set<string>
  databaseUrl: string
}

function parseArgs(argv: string[]): Args {
  const skipIds = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip' && argv[i + 1] != null) {
      skipIds.add(argv[i + 1])
      i++
    }
  }
  const get = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }
  return {
    dryRun: argv.includes('--dry-run'),
    skipIds,
    databaseUrl: get('database') ?? serverConfig.databaseUrl
  }
}

function remuxParent(): string {
  return existsSync('/mnt/teamstation/work')
    ? REMOTE_WORK
    : join(tmpdir(), 'peertube-migrate')
}

function fmtGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

async function migrateOne(
  video: LibraryVideo,
  mediaRoot: string,
  databaseUrl: string
): Promise<{ bytes: number }> {
  const { space, ffmpegPath } = serverConfig
  if (!spaceConfigured(space)) throw new Error('no Space is configured')

  const file = await locateVideoFile({
    mediaRoot,
    storage: video.storage,
    videoId: video.id
  })
  if (file == null) {
    throw new Error('no fragmented MP4 on disk')
  }

  const probed = await probeVideoFile(ffmpegPath, file)
  await mkdir(remuxParent(), { recursive: true })
  const work = await mkdtemp(join(remuxParent(), `${video.id}-`))
  try {
    await remuxToHls(ffmpegPath, {
      input: file,
      outDir: work,
      videoTag: tagFor(probed.codecName)
    })
    const files = [MASTER_PLAYLIST, MEDIA_PLAYLIST, VIDEO_FILE]
    const uploaded = await uploadVideoDirectory({
      space,
      videoId: video.id,
      dir: work,
      files
    })
    const verified = await verifyVideoDirectory({
      space,
      videoId: video.id,
      dir: work,
      files: uploaded.files
    })
    if (!verified.ok) {
      throw new Error(`the Space did not verify: ${verified.reason}`)
    }

    const now = new Date()
    const db = makeDatabase(databaseUrl)
    try {
      await db
        .updateTable('videos')
        .set({
          storage: 'spaces',
          status: 'ready',
          status_message: null,
          size_bytes: String(uploaded.bytes),
          spaces_verified_at: now,
          local_delete_after: new Date(now.getTime() + LOCAL_GRACE_MS),
          updated_at: now
        })
        .where('id', '=', video.id)
        .execute()
    } finally {
      await db.destroy()
    }
    return { bytes: uploaded.bytes }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const { space } = serverConfig
  if (!args.dryRun && !spaceConfigured(space)) {
    throw new Error('no Space is configured')
  }

  const db = makeDatabase(args.databaseUrl)
  const wanted: Array<{ video: LibraryVideo; reason: string }> = []
  let skipped = 0
  try {
    const rows = await db
      .selectFrom('videos')
      .select([
        'id',
        'title',
        'kind',
        'storage',
        'game_id',
        'start_at',
        'start_at_source',
        'num_cameras'
      ])
      .execute()

    const library: LibraryVideo[] = rows.map(row => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      storage: row.storage,
      gameId: row.game_id,
      startAt: row.start_at,
      startAtSource: row.start_at_source,
      numCameras: row.num_cameras
    }))

    for (const video of library) {
      const decision = moveDecision(video, library, args.skipIds)
      if (decision.action === 'skip') {
        skipped += 1
        continue
      }
      wanted.push({ video, reason: decision.reason })
    }

    console.log(
      `${wanted.length} to copy, ${skipped} skipped` +
        (args.skipIds.size > 0
          ? ` (including --skip ${[...args.skipIds].join(', ')})`
          : '')
    )
    for (const { video, reason } of wanted) {
      const { slot } = slotOf(asRow(video))
      console.log(`  ${slot}  ${video.id}  ${video.title}  (${reason})`)
    }
    if (args.dryRun) return
  } finally {
    await db.destroy()
  }

  const mediaRoot = serverConfig.mediaDir
  let copied = 0
  let failed = 0
  for (const { video, reason } of wanted) {
    const label = `${video.id}  ${video.title}`
    console.log(`\n${label}`)
    console.log(`  ${reason}`)
    try {
      const { bytes } = await migrateOne(video, mediaRoot, args.databaseUrl)
      console.log(`  copied ${fmtGiB(bytes)}, verified`)
      copied += 1
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      console.log(`  FAILED — ${why.split('\n').slice(-3).join(' ')}`)
      failed += 1
    }
  }
  console.log(`\n${copied} copied, ${failed} failed, ${skipped} skipped`)
  if (failed > 0) process.exitCode = 1
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
