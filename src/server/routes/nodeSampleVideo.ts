import { createWriteStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type Request, type Response, Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized, unavailable } from '../../common/errors'
import { makeId } from '../../common/ids'
import {
  SAMPLE_MAX_BYTES,
  sampleProbeProblem,
  sampleSizeProblem
} from '../../common/sponsors/limits'
import { requireNodeAdmin } from '../admin/nodeAdministration'
import type { Database } from '../db/database'
import { putObjectFile } from '../media/images'
import type { MediaContext } from '../media/mediaContext'
import { spaceConfigured } from '../media/spacesHls'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { setSponsorSampleKey } from '../nodeSettings'
import { isMp4 } from '../sponsors/media'
import { probeSponsorVideo } from '../sponsors/probe'
import { dropReplacedSample } from '../sponsors/sample'

export interface NodeSampleVideoOptions {
  /** The upload waits under `<uploadsDir>/sponsors/` while it is probed. */
  uploadsDir: string
  /** The clock that dates the stored object's key; the real one by default. */
  clock?: () => Date
}

/** What the screen says of a file past the cap, read no further. */
const TOO_LARGE = sampleSizeProblem(SAMPLE_MAX_BYTES + 1)!

/**
 * Reads the rest of a refused request's body and drops it, up to `left`
 * bytes, so the refusal goes out after the whole request has arrived: a proxy
 * in front (Caddy) that is still sending the body when the connection closes
 * answers a 502 of its own instead. Answers whether the body ended in time.
 */
async function dropped(req: Request, left: number): Promise<boolean> {
  if (req.readableEnded) return true
  return await new Promise(resolve => {
    let read = 0
    const settle = (ended: boolean): void => {
      req.off('data', each)
      req.off('end', finished)
      req.off('error', failed)
      if (!ended) req.pause()
      resolve(ended)
    }
    const each = (chunk: Buffer): void => {
      read += chunk.length
      if (read > left) settle(false)
    }
    const finished = (): void => {
      settle(true)
    }
    const failed = (): void => {
      settle(false)
    }
    req.on('data', each)
    req.once('end', finished)
    req.once('error', failed)
    req.resume()
  })
}

/**
 * Writes the request's body to `file`, counting as it goes. Past `cap` it
 * stops writing and refuses with the sentence: nothing past the cap is kept.
 * The rest of a body up to twice the cap is read and dropped first, so the
 * sentence reaches the caller through a proxy; a longer one has its
 * connection closed once the refusal is sent, so the rest is never read. A
 * declared length past twice the cap is refused before a byte is read.
 * Answers how many bytes were written.
 */
async function receive(
  req: Request,
  res: Response,
  file: string,
  cap: number
): Promise<number> {
  /** Refuses, having dropped at most `left` more bytes of the body. */
  const stop = async (left: number): Promise<never> => {
    if (left <= 0 || !(await dropped(req, left))) {
      res.setHeader('connection', 'close')
      res.once('finish', () => {
        req.destroy()
      })
    }
    throw badRequest(TOO_LARGE)
  }
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > cap)
    return await stop(declared > 2 * cap ? 0 : declared)
  const out = createWriteStream(file)
  let bytes = 0
  const outcome = await new Promise<'done' | 'over'>((resolve, reject) => {
    const over = (): void => {
      req.off('data', counted)
      req.unpipe(out)
      req.pause()
      out.destroy()
      resolve('over')
    }
    const counted = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > cap) over()
    }
    req.on('data', counted)
    req.once('error', reject)
    out.once('error', reject)
    out.once('finish', () => {
      resolve('done')
    })
    req.pipe(out)
  })
  if (outcome === 'over') return await stop(2 * cap - bytes)
  return bytes
}

/** The first `count` bytes of a file, or fewer where it is shorter. */
async function firstBytes(path: string, count: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(count)
    const { bytesRead } = await handle.read(buffer, 0, count, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * The node's sponsor sample video, which a league's previews play when it has
 * no footage of its own:
 *
 * - `PUT /node/sponsor-sample`, a node administrator's file's raw bytes →
 *   the node's `SponsorSettings`, its `sampleKey` the new object. Checked,
 *   never changed: an MP4 of H.264 or HEVC, 1920 × 1080, at most 60 fps, two minutes
 *   and 120 MB. A file that does not fit is a 400 with the screen's
 *   sentence, and one past 120 MB is not kept past the cap. The upload it
 *   replaces is deleted from the Space once the new key is saved.
 */
export function nodeSampleVideoRoutes(
  db: Kysely<Database>,
  media: Pick<MediaContext, 'space' | 'ffmpegPath'>,
  options: NodeSampleVideoOptions
): Router {
  const router = Router()
  const clock = options.clock ?? (() => new Date())
  router.put(
    '/node/sponsor-sample',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      // Who may first: nobody else's body is read.
      await requireNodeAdmin(
        db,
        req.actor,
        'Only a node administrator can change the sponsor sample video'
      )
      if (!spaceConfigured(media.space))
        throw unavailable('The sample video needs media storage on this server')
      const dir = join(options.uploadsDir, 'sponsors')
      await mkdir(dir, { recursive: true })
      const id = makeId('sponsorMedia')
      const file = join(dir, `${id}.mp4`)
      try {
        const bytes = await receive(req, res, file, SAMPLE_MAX_BYTES)
        if (bytes === 0) throw badRequest('Choose a file to upload.')
        const probe = await probeSponsorVideo(media.ffmpegPath, file)
        const problem = sampleProbeProblem(probe, bytes)
        if (problem != null) throw badRequest(problem)
        // Stored and served as `video/mp4`: an H.264 Matroska or MPEG-TS
        // file probes as well, but no browser or phone plays it as one.
        if (!isMp4(await firstBytes(file, 12)))
          throw badRequest('The sample video must be an MP4 file.')
        const day = clock().toISOString().slice(0, 10)
        const key = `sponsors/sample/${day}-${id}.mp4`
        await putObjectFile({
          space: media.space,
          key,
          path: file,
          contentType: 'video/mp4',
          acl: 'public-read',
          // A new upload is a new key, so a copy may be kept for good.
          cacheControl: 'public, max-age=31536000, immutable'
        })
        const { settings, replaced } = await setSponsorSampleKey(
          db,
          req.actor,
          key
        )
        // The clip it replaced is no longer anybody's: no row holds it.
        await dropReplacedSample(media.space, replaced, key)
        res.json(settings)
      } finally {
        await rm(file, { force: true })
      }
    })
  )
  return router
}
