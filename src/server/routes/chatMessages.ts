import {
  asArray,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import { MAX_ATTACHMENTS } from '../../common/chatContent'
import { isIdentityId, isMessageId } from '../../common/chatCrypto/messageIds'
import { ENVELOPE_KINDS } from '../../common/chatCrypto/seal'
import { notFound } from '../../common/errors'
import { chatCaller } from '../chat/keys'
import {
  type ChatObjectStore,
  conversationOfMessage,
  DEFAULT_PAGE,
  DELETE_KINDS,
  markRead,
  MAX_CIPHERTEXT,
  MAX_PAGE,
  MAX_TARGETS,
  type MessageBody,
  messagesOf,
  postMessage,
  reportMessage,
  reportsFor,
  resolveReport
} from '../chat/messages'
import { memberNow } from '../chat/reconciler'
import { asBase64urlBytes } from '../chat/wire'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { setAudit, skipAudit } from '../middleware/withAudit'
import { requireActor, requireAdmin } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

const asMessageId: Cleaner<string> = raw => {
  if (!isMessageId(raw)) throw new TypeError('Expected a msg_ message id')
  return raw
}

const asIdentityId: Cleaner<string> = raw => {
  if (!isIdentityId(raw)) throw new TypeError('Expected a cid_ identity id')
  return raw
}

const asWhole =
  (low: number, high: number, what: string): Cleaner<number> =>
  raw => {
    const value = asNumber(raw)
    if (!Number.isSafeInteger(value) || value < low || value > high) {
      throw new TypeError(`Expected ${what}`)
    }
    return value
  }

const asAttachmentId: Cleaner<string> = raw => {
  const text = asString(raw)
  if (text === '' || text.length > 100) {
    throw new TypeError('Expected an attachment id')
  }
  return text
}

const asEnvelope = asObject({
  id: asMessageId,
  epoch: asWhole(1, 2_147_483_647, 'an epoch'),
  kind: asLiteral(...ENVELOPE_KINDS),
  senderIdentityId: asIdentityId,
  targetIds: asOptional(asArray(asMessageId)),
  attachmentIds: asOptional(asArray(asAttachmentId)),
  nonce: asBase64urlBytes(24),
  ciphertext: asBase64urlBytes(1, MAX_CIPHERTEXT),
  signature: asBase64urlBytes(64)
})

/**
 * A message envelope: `targetIds` on the two delete kinds and nowhere else,
 * `attachmentIds` on posts only, neither repeating an id.
 */
const asMessageBody: Cleaner<MessageBody> = raw => {
  const body = asEnvelope(raw)
  const deletes = DELETE_KINDS.includes(body.kind)
  const targetIds = body.targetIds ?? null
  if (deletes !== (targetIds != null)) {
    throw new TypeError(
      deletes
        ? `A ${body.kind} names its targetIds`
        : `A ${body.kind} carries no targetIds`
    )
  }
  if (
    targetIds != null &&
    (targetIds.length === 0 ||
      targetIds.length > MAX_TARGETS ||
      new Set(targetIds).size !== targetIds.length)
  ) {
    throw new TypeError(`Expected 1 to ${MAX_TARGETS} different targetIds`)
  }
  const attachmentIds = body.attachmentIds ?? []
  if (attachmentIds.length > 0 && body.kind !== 'post') {
    throw new TypeError('Only a post carries attachmentIds')
  }
  if (
    attachmentIds.length > MAX_ATTACHMENTS ||
    new Set(attachmentIds).size !== attachmentIds.length
  ) {
    throw new TypeError(
      `Expected at most ${MAX_ATTACHMENTS} different attachmentIds`
    )
  }
  return { ...body, targetIds, attachmentIds }
}

const asReadBody = asObject({
  seq: asWhole(0, Number.MAX_SAFE_INTEGER, 'a seq')
})

const asReportBody = asObject({
  messageId: asMessageId,
  plaintext: (raw: unknown) => {
    const text = asString(raw)
    if (text.length > MAX_CIPHERTEXT) throw new TypeError('Plaintext too long')
    return text
  },
  messageKey: asBase64urlBytes(32)
})

/** A whole number from a query string, or undefined when absent or not one. */
function queryNumber(value: unknown): number | undefined {
  return typeof value === 'string' && /^\d{1,15}$/.test(value)
    ? Number(value)
    : undefined
}

export interface ChatMessageRouteOptions {
  clock?: () => Date
  /** Where attachment objects live (the Space, from M10 on). */
  objects?: ChatObjectStore
}

/**
 * Messages, read cursors and reports (`chat/messages.ts`). The member routes
 * need a signed-in session (`sessionRequired` for a machine token) and
 * answer 404 to anybody not in the conversation now (`memberNow`).
 *
 * - `POST /chat/conversations/:id/messages`: post an envelope (201, or 200
 *   with the stored row for a repeat); `GET …/messages?after=&before=&limit=`.
 * - `PUT /chat/conversations/:id/read` `{ seq }`: move the read cursor on.
 * - `POST /chat/reports` `{ messageId, plaintext, messageKey }`.
 * - `GET /admin/chat/reports?open=`, `PUT /admin/chat/reports/:id/resolve`:
 *   site administrators only.
 *
 * Message and read routes are not audited (`skipAudit`); reports are.
 * Refusals carry `details.reason`: `notHolder`, `notStaff`,
 * `notModerator`, `notYours` (403); `idTaken`, `closed`, `staleIdentity`,
 * `staleEpoch`, `locked`, `cleared` (409); `badSignature`, `target`,
 * `attachment`, `seq` (400).
 */
export function chatMessageRoutes(
  db: Kysely<Database>,
  media: MediaContext,
  options: ChatMessageRouteOptions = {}
): Router {
  const router = Router()
  const clock = options.clock ?? (() => new Date())

  const mustBeMember = async (
    conversationId: string,
    userId: number
  ): Promise<void> => {
    if (!(await memberNow(db, conversationId, userId, clock()))) {
      throw notFound()
    }
  }

  router.post(
    '/chat/conversations/:conversationId/messages',
    requireActor,
    withAsync(async (req, res) => {
      skipAudit(res.locals)
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, caller.userId)
      const body = cleanBody(asMessageBody, req.body)
      const posted = await postMessage(
        db,
        caller,
        id,
        body,
        clock(),
        options.objects
      )
      res.status(posted.created ? 201 : 200).json(posted.message)
    })
  )

  router.get(
    '/chat/conversations/:conversationId/messages',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, caller.userId)
      const limit = queryNumber(req.query.limit) ?? DEFAULT_PAGE
      res.json(
        await messagesOf(db, id, {
          after: queryNumber(req.query.after),
          before: queryNumber(req.query.before),
          limit: Math.min(Math.max(limit, 1), MAX_PAGE)
        })
      )
    })
  )

  router.put(
    '/chat/conversations/:conversationId/read',
    requireActor,
    withAsync(async (req, res) => {
      skipAudit(res.locals)
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, caller.userId)
      const body = cleanBody(asReadBody, req.body)
      res.json(await markRead(db, id, caller.userId, body.seq, clock()))
    })
  )

  router.post(
    '/chat/reports',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const body = cleanBody(asReportBody, req.body)
      const conversationId = await conversationOfMessage(db, body.messageId)
      if (conversationId == null) throw notFound()
      await mustBeMember(conversationId, caller.userId)
      const report = await reportMessage(db, caller.userId, body, clock())
      setAudit(res.locals, {
        entityType: 'chatReport',
        entityId: report.id,
        after: { messageId: body.messageId, verified: report.verified }
      })
      res.status(201).json(report)
    })
  )

  router.get(
    '/admin/chat/reports',
    requireAdmin,
    withAsync(async (req, res) => {
      res.json(
        await reportsFor(db, media.space, {
          open: req.query.open === 'true' || req.query.open === '1'
        })
      )
    })
  )

  router.put(
    '/admin/chat/reports/:reportId/resolve',
    requireAdmin,
    withAsync(async (req, res) => {
      const id = pathParam(req.params.reportId)
      const report = await resolveReport(db, media.space, id, clock())
      setAudit(res.locals, {
        entityType: 'chatReport',
        entityId: id,
        after: { resolvedAt: report.resolvedAt }
      })
      res.json(report)
    })
  )

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
