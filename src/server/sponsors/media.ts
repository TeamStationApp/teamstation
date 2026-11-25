import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Kysely } from 'kysely'

import { badRequest, unavailable } from '../../common/errors'
import { makeId } from '../../common/ids'
import {
  imageProblem,
  reelProbeProblem,
  sizeProblem
} from '../../common/sponsors/limits'
import type {
  SponsorMediaPurpose,
  UploadedSponsorMedia
} from '../../common/sponsors/types'
import type { Database } from '../db/database'
import { deleteObject, putObject, putObjectFile } from '../media/images'
import { spaceConfigured, type SpaceSettings } from '../media/spacesHls'
import { mediaUrl } from './credits'
import { imageHeader } from './imageHeader'
import { probeSponsorVideo } from './probe'

/** What storing a sponsor upload needs. */
export interface SponsorMediaContext {
  db: Kysely<Database>
  space: SpaceSettings
  /** The pinned build; its ffprobe reads a reel. */
  ffmpegPath: string
  /** A reel waits under `<uploadsDir>/sponsors/` while it is probed. */
  uploadsDir: string
}

/** An upload never changes, so a copy may be kept for good. */
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** An MP4 (ISO base media) file's first box is `ftyp`. */
const isMp4 = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp'

function refuse(problem: string | null): void {
  if (problem != null) throw badRequest(problem)
}

/**
 * Checks an upload for `purpose` and stores it: its size, then its magic
 * bytes, then its dimensions or ffprobe's reading. The server never
 * transcodes, resizes or re-encodes: the client already shrank it, so a file
 * that does not fit is refused with the sentence the screen shows. An
 * accepted file goes to `sponsors/<leagueId>/<mediaId>.<ext>`, public, and
 * gets its `sponsor_media` row.
 */
export async function storeSponsorMedia(
  context: SponsorMediaContext,
  upload: {
    leagueId: string
    purpose: SponsorMediaPurpose
    bytes: Buffer
    userId: string
  }
): Promise<UploadedSponsorMedia> {
  const { db, space } = context
  const { leagueId, purpose, bytes } = upload
  refuse(sizeProblem(purpose, bytes.length))
  if (!spaceConfigured(space))
    throw unavailable('Sponsor uploads need media storage on this server')
  const mediaId = makeId('sponsorMedia')
  let stored: {
    contentType: string
    extension: string
    width: number
    height: number
    durationMs: number | null
  }
  let key: string
  if (purpose === 'reel') {
    if (!isMp4(bytes)) throw badRequest('Reels must be H.264 MP4 files.')
    const dir = join(context.uploadsDir, 'sponsors')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${mediaId}.mp4`)
    try {
      await writeFile(file, bytes)
      const probe = await probeSponsorVideo(context.ffmpegPath, file)
      refuse(reelProbeProblem(probe, bytes.length))
      stored = {
        contentType: 'video/mp4',
        extension: 'mp4',
        width: probe.width,
        height: probe.height,
        durationMs: Math.round(probe.durationSec * 1000)
      }
      key = `sponsors/${leagueId}/${mediaId}.mp4`
      await putObjectFile({
        space,
        key,
        path: file,
        contentType: stored.contentType,
        acl: 'public-read',
        cacheControl: IMMUTABLE
      })
    } finally {
      await rm(file, { force: true })
    }
  } else {
    const header = imageHeader(bytes)
    refuse(imageProblem(purpose, header, bytes.length))
    const image = header!
    stored = {
      contentType: image.type,
      extension: image.type === 'image/png' ? 'png' : 'jpg',
      width: image.width,
      height: image.height,
      durationMs: null
    }
    key = `sponsors/${leagueId}/${mediaId}.${stored.extension}`
    await putObject({
      space,
      key,
      body: bytes,
      contentType: stored.contentType,
      acl: 'public-read',
      cacheControl: IMMUTABLE
    })
  }
  await db
    .insertInto('sponsor_media')
    .values({
      id: mediaId,
      league_id: leagueId,
      purpose,
      object_key: key,
      content_type: stored.contentType,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: stored.width,
      height: stored.height,
      duration_ms: stored.durationMs,
      created_by: upload.userId
    })
    .execute()
  return {
    mediaId,
    url: mediaUrl(space, key),
    width: stored.width,
    height: stored.height,
    durationMs: stored.durationMs
  }
}

/** How long an upload may wait for a row to use it. */
export const UNUSED_MEDIA_MS = 24 * 60 * 60 * 1000

/**
 * Deletes every upload older than a day that nothing uses — no logo, reel,
 * sponsored row or game placement — with its object. Answers how many went.
 * A row being added with one at the same moment keeps it: the delete waits
 * on that insert's key lock and then fails, and the upload stays.
 */
export async function sweepSponsorMedia(
  db: Kysely<Database>,
  space: SpaceSettings,
  now: Date,
  log: (message: string) => void = console.error
): Promise<number> {
  const unused = await db
    .selectFrom('sponsor_media')
    .select(['id', 'object_key'])
    .where('created_at', '<', new Date(now.getTime() - UNUSED_MEDIA_MS))
    .where(eb =>
      eb.not(
        eb.or([
          eb.exists(
            eb
              .selectFrom('sponsor_logos')
              .select('id')
              .whereRef('sponsor_logos.media_id', '=', 'sponsor_media.id')
          ),
          eb.exists(
            eb
              .selectFrom('sponsor_reels')
              .select('id')
              .whereRef('sponsor_reels.media_id', '=', 'sponsor_media.id')
          ),
          eb.exists(
            eb
              .selectFrom('sponsor_rows')
              .select('id')
              .where(row =>
                row.or([
                  row(
                    'sponsor_rows.logo_media_id',
                    '=',
                    row.ref('sponsor_media.id')
                  ),
                  row(
                    'sponsor_rows.background_media_id',
                    '=',
                    row.ref('sponsor_media.id')
                  )
                ])
              )
          ),
          eb.exists(
            eb
              .selectFrom('game_sponsor_logos')
              .select('game_id')
              .whereRef('game_sponsor_logos.media_id', '=', 'sponsor_media.id')
          ),
          eb.exists(
            eb
              .selectFrom('game_reel_placements')
              .select('id')
              .whereRef(
                'game_reel_placements.media_id',
                '=',
                'sponsor_media.id'
              )
          )
        ])
      )
    )
    .limit(500)
    .execute()
  let gone = 0
  for (const media of unused) {
    try {
      const deleted = await db
        .deleteFrom('sponsor_media')
        .where('id', '=', media.id)
        .executeTakeFirst()
      if (deleted.numDeletedRows === 0n) continue
    } catch {
      // Something began using it after the read: it stays.
      continue
    }
    try {
      await deleteObject({ space, key: media.object_key })
    } catch (error) {
      log(`sponsor media sweep: ${String(error)}`)
    }
    gone++
  }
  return gone
}
