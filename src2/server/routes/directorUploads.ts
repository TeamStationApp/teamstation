import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { asNumber, asObject, asOptional, asString } from 'cleaners'
import express, { Router } from 'express'
import type { Kysely, Selectable } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import { makeId } from '../../common/ids'
import { adminScopes } from '../access'
import type { Database, DirectorUploadsTable } from '../db/database'
import {
  assembleParts,
  ensureUploadDir,
  failureToShow,
  isComplete,
  liveToReplace,
  missingParts,
  PART_SIZE,
  partBytes,
  partCount,
  partName,
  purgeDateFor,
  receivedBytes,
  receivedParts,
  recordingStart,
  startOf,
  uploadDir
} from '../director/uploads'
import { ingestVideoFile } from '../media/ingestFile'
import { spaceConfigured, type SpaceSettings } from '../media/spacesHls'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

/**
 * Where GS Director sends the recording it made.
 *
 * The stream is what people watched live, and it is the worst copy of that
 * game that will ever exist: it went out over a ball field's uplink at
 * whatever bitrate the moment allowed. The iPad kept a better one the whole
 * time. These routes are how it gets here, and what happens to the stream
 * when it does.
 *
 * **In parts, resumable, by design.** See `director/uploads.ts` for why. The
 * shape from the app's side:
 *
 *   POST   /director/uploads                 → { uploadId, partSize, parts }
 *   PUT    /director/uploads/:id/parts/:n    ← the bytes of one part
 *   GET    /director/uploads/:id             → what has landed, what is left
 *   POST   /director/uploads/:id/finish      → { videoId }
 *   DELETE /director/uploads/:id             → give up, and take the parts
 *
 * Asking before sending is not optional politeness: it is how an app that was
 * killed half way through a nine-gigabyte upload carries on instead of
 * starting again.
 */

export interface DirectorUploadRouteOptions {
  /** Where the parts wait. Scratch, not media: see `serverConfig`. */
  uploadsDir: string
  ffmpegPath: string
  space?: SpaceSettings
}

const asNewUpload = asObject({
  gameId: asString,
  title: asString,
  /** `program` for the programme output, or the camera's own name. */
  kind: asOptional(asString, 'program'),
  filename: asString,
  sizeBytes: asNumber,
  /**
   * When the recording began, ISO 8601. Not decoration: the library places a
   * video on the game's wall clock and the multi-camera view aligns a take's
   * angles on it, so two cameras of one take must arrive saying the same
   * instant however far apart they were sent.
   */
  startAt: asOptional(asString)
})

/** The largest single part this will take, with room over `PART_SIZE`. */
const PART_LIMIT = PART_SIZE + 1024 * 1024

export function directorUploadRoutes(
  db: Kysely<Database>,
  options: DirectorUploadRouteOptions
): Router {
  const router = Router()

  /**
   * The Space, or a sentence saying why there is nowhere to put this.
   *
   * Asked before a byte is taken rather than after nine gigabytes have
   * arrived: a server with no Space configured cannot finish an upload, and
   * the honest moment to say so is when it is offered one.
   */
  const theSpace = (): SpaceSettings => {
    const space = options.space
    if (space == null || !spaceConfigured(space)) {
      throw badRequest('This server has nowhere to put a recording.')
    }
    return space
  }

  /** The upload, if it is this account's and still worth talking about. */
  const mine = async (
    uploadId: string,
    userId: string
  ): Promise<Selectable<DirectorUploadsTable>> => {
    const row = await db
      .selectFrom('director_uploads')
      .selectAll()
      .where('id', '=', uploadId)
      .executeTakeFirst()
    // Somebody else's upload is not found rather than forbidden: an id is not
    // a thing to confirm the existence of.
    if (row?.user_id !== userId) throw notFound()
    return row
  }

  /**
   * A game this account may put a recording on.
   *
   * The same rule as claiming one to stream: the person holding the camera is
   * the person who runs the team. An upload naming a game they do not run is
   * not found, for the same reason as above.
   */
  const gameIRun = async (
    gameId: string,
    userId: string,
    isAdmin: boolean
  ): Promise<{ id: string; startAt: Date }> => {
    const game = await db
      .selectFrom('games')
      .select([
        'id',
        'start_at as startAt',
        'home_team_id as home',
        'away_team_id as away'
      ])
      .where('id', '=', gameId)
      .executeTakeFirst()
    if (game == null) throw notFound()
    const scopes = await adminScopes(db, userId, isAdmin)
    const allowed =
      scopes.isAdmin ||
      scopes.teamIds.has(game.home) ||
      scopes.teamIds.has(game.away)
    if (!allowed) throw notFound()
    return { id: game.id, startAt: new Date(game.startAt) }
  }

  const state = async (row: {
    id: string
    size_bytes: string
    part_size: number
    state: string
    step: string | null
    video_id: string | null
    message: string | null
  }): Promise<Record<string, unknown>> => {
    const dir = uploadDir(options.uploadsDir, row.id)
    const parts = partCount(Number(row.size_bytes), row.part_size)
    // The directory is the truth about what has arrived — until the upload is
    // taken in and the parts are deleted, at which point the directory says
    // nothing arrived at all. An upload that is `ready` has every part by
    // definition, and reporting `received: []` for it read as an upload that
    // had lost its bytes.
    const settled = row.state === 'ready' || row.state === 'assembling'
    const received = settled
      ? Array.from({ length: parts }, (_, index) => index)
      : await receivedParts(dir)
    return {
      uploadId: row.id,
      state: row.state,
      // Which part of taking it in, while it is being taken in, so a screen
      // can say what is happening rather than showing a still bar.
      step: row.step,
      partSize: row.part_size,
      parts,
      received,
      missing: missingParts(received, parts),
      receivedBytes: settled
        ? Number(row.size_bytes)
        : await receivedBytes(dir),
      videoId: row.video_id,
      message: row.message
    }
  }

  /** Opens one, and says how to send it. */
  router.post(
    '/director/uploads',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const body = asNewUpload(req.body)
      if (body.sizeBytes <= 0) throw badRequest('That recording is empty.')
      theSpace()
      const game = await gameIRun(body.gameId, actor.userId, actor.isAdmin)

      const uploadId = makeId('directorUpload')
      await ensureUploadDir(options.uploadsDir, uploadId)
      await db
        .insertInto('director_uploads')
        .values({
          id: uploadId,
          user_id: actor.userId,
          game_id: game.id,
          title: body.title,
          kind: body.kind,
          filename: body.filename,
          size_bytes: String(Math.round(body.sizeBytes)),
          part_size: PART_SIZE,
          started_at: recordingStart(body.startAt)
        })
        .execute()
      setAudit(res.locals, { entityType: 'directorUpload', entityId: uploadId })

      res.status(201).json({
        uploadId,
        partSize: PART_SIZE,
        parts: partCount(body.sizeBytes, PART_SIZE),
        received: []
      })
    })
  )

  /** What has landed, so the app knows what to send next. */
  router.get(
    '/director/uploads/:id',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const row = await mine(String(req.params.id), actor.userId)
      res.json(await state(row))
    })
  )

  /**
   * One part.
   *
   * Writing it twice is not an error: an app that lost the reply and sent it
   * again is the ordinary way a flaky network behaves, and refusing the
   * repeat would strand the upload.
   */
  router.put(
    '/director/uploads/:id/parts/:index',
    requireActor,
    express.raw({ type: '*/*', limit: PART_LIMIT }),
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const row = await mine(String(req.params.id), actor.userId)
      // `failed` takes parts again: what failed is the conversion, and an
      // operator whose recording was refused for being short a part must be
      // able to send that part rather than the whole nine gigabytes again.
      if (row.state !== 'open' && row.state !== 'failed') {
        throw badRequest(
          `This upload is ${row.state}, and takes no more parts.`
        )
      }

      const index = Number(req.params.index)
      const total = partCount(Number(row.size_bytes), row.part_size)
      if (!Number.isInteger(index) || index < 0 || index >= total) {
        throw badRequest(
          `There is no part ${String(req.params.index)} of this recording.`
        )
      }
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw badRequest('That part carried no bytes.')
      }
      const expected = partBytes(index, Number(row.size_bytes), row.part_size)
      if (body.length !== expected) {
        // A short part is the failure that assembles into a recording which
        // plays until it does not, so it is refused rather than stored.
        throw badRequest(
          `Part ${index} should be ${expected} bytes and arrived as ${body.length}.`
        )
      }

      const dir = await ensureUploadDir(options.uploadsDir, row.id)
      await writeFile(join(dir, partName(index)), body)

      const received = await receivedParts(dir)
      await db
        .updateTable('director_uploads')
        .set({
          received_bytes: String(await receivedBytes(dir)),
          updated_at: new Date()
        })
        .where('id', '=', row.id)
        .execute()

      res.json({
        received: received.length,
        parts: total,
        missing: missingParts(received, total)
      })
    })
  )

  /**
   * Every part is here: make it a video.
   *
   * The work is the same sequence every other whole file takes — assemble,
   * probe, remux, copy, verify, write the row — and then the part this
   * endpoint exists for: the live recording of that game steps aside.
   */
  router.post(
    '/director/uploads/:id/finish',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const row = await mine(String(req.params.id), actor.userId)
      const space = theSpace()
      if (row.state === 'ready' && row.video_id != null) {
        // Asked twice: the same answer, not a second video.
        res.json({ videoId: row.video_id, state: row.state })
        return
      }
      // A failed upload can be asked again. Its parts are still on disk —
      // that is the whole reason they are kept — so what a retry costs is the
      // conversion and not the upload. Before this, `failed` was a dead end:
      // the parts could not be added to, the upload could not be finished,
      // and nothing reclaimed the disk, so a nine-gigabyte take that failed
      // at the probe left eighteen gigabytes behind for ever.
      if (row.state !== 'open' && row.state !== 'failed') {
        throw badRequest(`This upload is ${row.state}.`)
      }
      if (row.game_id == null) throw badRequest('This upload names no game.')

      const dir = uploadDir(options.uploadsDir, row.id)
      const total = partCount(Number(row.size_bytes), row.part_size)
      const received = await receivedParts(dir)
      if (!isComplete(received, total)) {
        throw badRequest(
          `${missingParts(received, total).length} parts have not arrived yet.`
        )
      }

      await db
        .updateTable('director_uploads')
        .set({
          state: 'assembling',
          step: 'assembling',
          message: null,
          updated_at: new Date()
        })
        .where('id', '=', row.id)
        .execute()
      setAudit(res.locals, { entityType: 'directorUpload', entityId: row.id })

      const game = await gameIRun(row.game_id, actor.userId, actor.isAdmin)

      // Answered now, worked on behind. Everything that can be refused has
      // been refused above — the upload is the caller's, its parts are all
      // here, the game is one they run — so what is left is minutes of file
      // work whose outcome the caller reads from `GET /director/uploads/:id`.
      res.status(202).json({ state: 'assembling', step: 'assembling' })

      takeItIn({ row, game, space, dir, total }).catch((error: unknown) => {
        // `takeItIn` writes every outcome to the row itself, so reaching here
        // means the writing failed too. Nothing is left to tell but the log.
        console.error(`taking in ${row.id}: ${String(error)}`)
      })
    })
  )

  /**
   * Turns a finished upload into a video, behind the request that asked for
   * it.
   *
   * Nothing here may throw into an Express handler — by the time it runs the
   * response has been sent — so every outcome, including an unexpected one,
   * is written to the row. An upload whose row says nothing is an upload an
   * app waits on for ever.
   */
  async function takeItIn(work: {
    row: Selectable<DirectorUploadsTable>
    game: { id: string; startAt: Date }
    space: SpaceSettings
    dir: string
    total: number
  }): Promise<void> {
    const { row, game, space, dir, total } = work
    const whole = join(dir, 'whole')
    const notes = async (step: string): Promise<void> => {
      await db
        .updateTable('director_uploads')
        .set({ step, updated_at: new Date() })
        .where('id', '=', row.id)
        .execute()
    }
    try {
      await assembleParts({ dir, total, into: whole })
      const ingested = await ingestVideoFile({
        db,
        space,
        ffmpegPath: options.ffmpegPath,
        file: whole,
        gameId: game.id,
        kind: 'program',
        title: row.title,
        // What the app said when it opened the upload; failing that, the
        // game's own time. Never when the upload happened to be opened —
        // that is a property of the network, and using it put a take's two
        // cameras thirty-four minutes apart in the multi-camera view.
        startAt: startOf(row.started_at, game.startAt),
        // How the start was *worked out*, not which program sent it. Every
        // value in this column is a method — a filename, a live session, a
        // publish date, somebody typing — and `distributor` is "the
        // recording told us". Both apps derive it the same way, out of the
        // take's own archive index, so both say this; it reads like an app
        // name and is not one.
        startAtSource: 'distributor',
        onStep: step => {
          notes(step).catch(() => {
            // A step nobody could write down is not worth failing an upload
            // for: it costs the screen its word, not the recording.
          })
        }
      })

      await replaceLiveRecording(db, game.id, ingested.videoId)

      await db
        .updateTable('director_uploads')
        .set({
          state: 'ready',
          step: null,
          video_id: ingested.videoId,
          updated_at: new Date()
        })
        .where('id', '=', row.id)
        .execute()

      // The parts have done their job and are several gigabytes.
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      // The whole of it goes to the log; what the operator is shown is the
      // sentence without the server's paths in it.
      console.error(`taking in ${row.id}: ${String(error)}`)
      const message = failureToShow(error)
      await db
        .updateTable('director_uploads')
        .set({ state: 'failed', step: null, message, updated_at: new Date() })
        .where('id', '=', row.id)
        .execute()
      // The parts stay: whatever went wrong here, sending nine gigabytes
      // again is the last resort and not the first, and `finish` will take
      // this upload again. What does not stay is the file assembled out of
      // them — it is the recording a second time over, it can be built again
      // from the parts in minutes, and leaving it doubled the disk every
      // failure cost.
      await rm(whole, { force: true })
    }
  }

  /** Given up on, with the parts. */
  router.delete(
    '/director/uploads/:id',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const row = await mine(String(req.params.id), actor.userId)
      await rm(uploadDir(options.uploadsDir, row.id), {
        recursive: true,
        force: true
      })
      await db
        .updateTable('director_uploads')
        .set({ state: 'abandoned', updated_at: new Date() })
        .where('id', '=', row.id)
        .execute()
      setAudit(res.locals, { entityType: 'directorUpload', entityId: row.id })
      res.status(204).end()
    })
  )

  return router
}

/**
 * The live recording of this game steps aside for the upload.
 *
 * Hidden now, and deleted in thirty days on a deployment that has turned the
 * sweep on. Hiding is instant and reversible, which matters while the upload
 * is the only thing anybody has checked; the purge is what stops the Space
 * being paid for ever for a copy on no page — and it stays off by default,
 * because more than one deployment reads the same bucket and only one of them
 * owns it.
 */
export async function replaceLiveRecording(
  db: Kysely<Database>,
  gameId: string,
  uploadedId: string
): Promise<string[]> {
  const videos = await db
    .selectFrom('videos')
    .select(['id', 'kind', 'hidden', 'duration_sec as durationSec'])
    .where('game_id', '=', gameId)
    .execute()

  // How long the upload turned out to be, which is what says whether it
  // covers the stream it would displace.
  const uploaded = videos.find(one => one.id === uploadedId)
  const replaced = liveToReplace(videos, uploadedId, uploaded?.durationSec)
  if (replaced.length === 0) return []

  const now = new Date()
  await db
    .updateTable('videos')
    .set({
      hidden: true,
      replaced_by: uploadedId,
      purge_after: purgeDateFor(now),
      updated_at: now
    })
    .where('id', 'in', replaced)
    .execute()
  return replaced
}
