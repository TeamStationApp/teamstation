import { asNumber, asObject, asString, type Cleaner } from 'cleaners'
import express, { type RequestHandler, Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, HttpError, notFound } from '../../common/errors'
import {
  CHAT_PART_LIMIT,
  completeAttachment,
  createAttachment,
  MAX_BLOB,
  putPart,
  readAttachment
} from '../chat/attachments'
import { chatCaller } from '../chat/keys'
import { asBase64urlBytes } from '../chat/wire'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import type { SpaceSettings } from '../media/spacesHls'
import { setAudit, skipAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

const asSize: Cleaner<number> = raw => {
  const value = asNumber(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BLOB) {
    throw new TypeError(`Expected a size of 1 to ${MAX_BLOB} bytes`)
  }
  return value
}

const asNewAttachment = asObject({
  conversationId: asString,
  size: asSize,
  digest: asBase64urlBytes(32)
})

const rawPart = express.raw({ type: () => true, limit: CHAT_PART_LIMIT })

/** A part's raw bytes, at most 9 MiB: over that is 413 `part`. */
const partBody: RequestHandler = (req, res, next) => {
  rawPart(req, res, (error?: unknown) => {
    if ((error as { type?: string } | undefined)?.type === 'entity.too.large') {
      next(
        new HttpError('tooLarge', 'A part is at most 9 MiB', { reason: 'part' })
      )
      return
    }
    next(error)
  })
}

export interface ChatAttachmentRouteOptions {
  /** Where finished attachments are kept. */
  space: SpaceSettings
  /** Scratch for parts: `<uploadsDir>/chat/<id>/`. */
  uploadsDir: string
  clock?: () => Date
}

/**
 * Encrypted attachments (`chat/attachments.ts`). Every route needs a
 * signed-in session (`sessionRequired` for a machine token) and answers 404
 * to anybody not in the attachment's conversation now.
 *
 * - `POST /chat/attachments` `{ conversationId, size, digest }` → 201
 *   `{ id, conversationId, size, completed: false, partSize, parts,
 *   missing }`.
 * - `PUT /chat/attachments/:id/parts/:n`, the raw bytes of part `n` (from
 *   0) → `{ received, parts, missing }`; the uploader only.
 * - `POST /chat/attachments/:id/complete` → `{ id, conversationId, size,
 *   digest, completed: true }`.
 * - `GET /chat/attachments/:id` → the finished attachment with `url`, a
 *   presigned GET good for 10 minutes, and `expiresAt`; or, to its uploader,
 *   the unfinished upload with what is `missing`.
 *
 * Refusals carry `details.reason`: `readOnly` (403); `completed`,
 * `partsMissing` with `missing` (409); `digestMismatch`, `part`, `noSpace`
 * (400); a part over 9 MiB is 413 `part`. Parts and reads are not audited.
 */
export function chatAttachmentRoutes(
  db: Kysely<Database>,
  options: ChatAttachmentRouteOptions
): Router {
  const router = Router()
  const clock = options.clock ?? (() => new Date())
  const context = {
    db,
    space: options.space,
    uploadsDir: options.uploadsDir
  }

  router.post(
    '/chat/attachments',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const body = cleanBody(asNewAttachment, req.body)
      const made = await createAttachment(context, caller, body, clock())
      setAudit(res.locals, { entityType: 'chatAttachment', entityId: made.id })
      res.status(201).json(made)
    })
  )

  router.put(
    '/chat/attachments/:attachmentId/parts/:index',
    requireActor,
    partBody,
    withAsync(async (req, res) => {
      skipAudit(res.locals)
      const caller = chatCaller(req.actor)
      const index = /^\d{1,6}$/.test(String(req.params.index))
        ? Number(req.params.index)
        : -1
      const bytes: unknown = req.body
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw badRequest('That part carried no bytes', { reason: 'part' })
      }
      res.json(
        await putPart(
          context,
          caller,
          pathParam(req.params.attachmentId),
          index,
          bytes,
          clock()
        )
      )
    })
  )

  router.post(
    '/chat/attachments/:attachmentId/complete',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.attachmentId)
      const done = await completeAttachment(context, caller, id, clock())
      setAudit(res.locals, { entityType: 'chatAttachment', entityId: id })
      res.json(done)
    })
  )

  router.get(
    '/chat/attachments/:attachmentId',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      res.json(
        await readAttachment(
          context,
          caller,
          pathParam(req.params.attachmentId),
          clock()
        )
      )
    })
  )

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
