import { asArray, asNumber, asObject, asString, type Cleaner } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { isIdentityId } from '../../common/chatCrypto/messageIds'
import { notFound } from '../../common/errors'
import { asUserId } from '../../common/userId'
import {
  createEpoch,
  epochsFor,
  grantsFor,
  MAX_GRANTS,
  postGrants
} from '../chat/epochs'
import { chatCaller } from '../chat/keys'
import { memberNow } from '../chat/reconciler'
import { asBase64urlBytes } from '../chat/wire'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

/** An HPKE box (`enc ‖ ciphertext`) of a 32-byte epoch key, with room to spare. */
const asBox = asBase64urlBytes(48, 4096)
/** `nonce ‖ ciphertext` of the previous epoch's 32-byte key. */
const asPreviousKeyBox = asBase64urlBytes(40, 4096)
const asSignature = asBase64urlBytes(64)

const asCount =
  (low: number, high: number, what: string): Cleaner<number> =>
  raw => {
    const value = asNumber(raw)
    if (!Number.isSafeInteger(value) || value < low || value > high) {
      throw new TypeError(`Expected ${what} from ${low}`)
    }
    return value
  }

const asEpochNumber = asCount(1, 2_147_483_647, 'an epoch')
const asGeneration = asCount(1, 1_000_000, 'a generation')

const asPreviousKeyBoxOrNull: Cleaner<Uint8Array | null> = raw =>
  raw == null ? null : asPreviousKeyBox(raw)

const asEpochBody = asObject({
  epoch: asEpochNumber,
  previousKeyBox: asPreviousKeyBoxOrNull,
  signature: asSignature,
  boxes: asArray(
    asObject({ userId: asUserId, pukGeneration: asGeneration, box: asBox })
  )
})

const asConversationId: Cleaner<string> = raw => {
  const text = asString(raw)
  if (text === '' || text.length > 100) {
    throw new TypeError('Expected a conversation id')
  }
  return text
}

const asIdentityId: Cleaner<string> = raw => {
  if (!isIdentityId(raw)) throw new TypeError('Expected a cid_ identity id')
  return raw
}

const asGrantBoxes = asArray(
  asObject({
    conversationId: asConversationId,
    epoch: asEpochNumber,
    userId: asUserId,
    identityId: asIdentityId,
    pukGeneration: asGeneration,
    box: asBox
  })
)

const asGrantsBody = asObject({
  boxes: (raw: unknown) => {
    const boxes = asGrantBoxes(raw)
    if (boxes.length === 0 || boxes.length > MAX_GRANTS) {
      throw new TypeError(`Expected 1 to ${MAX_GRANTS} boxes`)
    }
    return boxes
  }
})

/**
 * Epochs and history grants (`chat/epochs.ts`). Every route needs a
 * signed-in session (`sessionRequired` for a machine token); the two that
 * write need it bound to a linked device (`notHolder`).
 *
 * - `GET /chat/conversations/:id/epochs?after=`: the epochs after `after`
 *   and the caller's boxes; `POST /chat/conversations/:id/epochs`: the next
 *   epoch. Members only (`memberNow`); anybody else gets 404.
 * - `GET /chat/grants`: open grant requests in the caller's chats;
 *   `POST /chat/grants`: up to 500 boxes filling them.
 *
 * Refusals carry `details.reason`: `notHolder`, `notApprover` (403);
 * `epochTaken`, `closed` (409); `boxSet`, `badSignature`, `epochGap`,
 * `previousKeyBox` (400).
 */
export function chatEpochRoutes(
  db: Kysely<Database>,
  clock: () => Date = () => new Date()
): Router {
  const router = Router()

  const mustBeMember = async (
    conversationId: string,
    userId: string
  ): Promise<void> => {
    if (!(await memberNow(db, conversationId, userId, clock()))) {
      throw notFound()
    }
  }

  router.get(
    '/chat/conversations/:conversationId/epochs',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, caller.userId)
      const raw = typeof req.query.after === 'string' ? req.query.after : '0'
      const after = /^\d{1,9}$/.test(raw) ? Number(raw) : 0
      res.json(await epochsFor(db, caller, id, after))
    })
  )

  router.post(
    '/chat/conversations/:conversationId/epochs',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, caller.userId)
      const body = cleanBody(asEpochBody, req.body)
      const made = await createEpoch(db, caller, id, body, clock())
      setAudit(res.locals, {
        entityType: 'chatEpoch',
        entityId: `${id}:${made.epoch}`,
        after: {
          epoch: made.epoch,
          chainBreak: made.chainBreak,
          boxed: made.boxed
        }
      })
      res.status(201).json(made)
    })
  )

  router.get(
    '/chat/grants',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      res.json(await grantsFor(db, caller, clock()))
    })
  )

  router.post(
    '/chat/grants',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const body = cleanBody(asGrantsBody, req.body)
      const ids = [...new Set(body.boxes.map(box => box.conversationId))]
      for (const id of ids) await mustBeMember(id, caller.userId)
      const result = await postGrants(db, caller, body.boxes, clock())
      setAudit(res.locals, {
        entityType: 'chatGrant',
        entityId: caller.userId,
        after: {
          conversationIds: ids,
          filled: result.filled,
          skipped: result.skipped.length
        }
      })
      res.json(result)
    })
  )

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
