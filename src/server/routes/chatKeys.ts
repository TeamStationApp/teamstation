import { asArray, asNumber, asObject, asString, type Cleaner } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import { isIdentityId } from '../../common/chatCrypto/messageIds'
import { notFound } from '../../common/errors'
import { asUserId } from '../../common/userId'
import {
  approveLink,
  chatCaller,
  createLink,
  declineLink,
  devicesOf,
  enrol,
  identityById,
  linkById,
  myKeys,
  pendingLinks,
  postPuk,
  registerDevice,
  resetIdentity,
  resumeChallenge,
  resumeDevice,
  revokeDevice,
  userKeys
} from '../chat/keys'
import { asBase64urlBytes } from '../chat/wire'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import { setAudit, skipAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

/** A box: an HPKE `enc ‖ ciphertext` of a 32-byte key, with room to spare. */
const asBox = asBase64urlBytes(48, 4096)
const asKey = asBase64urlBytes(32)
const asSignature = asBase64urlBytes(64)

const asDeviceName: Cleaner<string> = raw => {
  const text = asString(raw).trim()
  if (text === '' || text.length > 100) {
    throw new TypeError('Expected a name of 1 to 100 characters')
  }
  return text
}

const asGeneration: Cleaner<number> = raw => {
  const value = asNumber(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new TypeError('Expected a generation from 1')
  }
  return value
}

const asDeviceBody = asObject({
  name: asDeviceName,
  platform: asLiteral('web', 'ios', 'android'),
  boxPublicKey: asKey,
  signPublicKey: asKey
})

const asIdentityId: Cleaner<string> = raw => {
  if (!isIdentityId(raw)) throw new TypeError('Expected a cid_ identity id')
  return raw
}

const asIdentityBody = asObject({
  identityId: asIdentityId,
  identityPublicKey: asKey,
  pukPublicKey: asKey,
  pukSignature: asSignature,
  box: asBox
})

const asResumeBody = asObject({
  nonce: asKey,
  signature: asSignature
})

const asPukBody = asObject({
  generation: asGeneration,
  publicKey: asKey,
  signature: asSignature,
  previousKeysBox: asBase64urlBytes(40, 1 << 20),
  boxes: asArray(asObject({ deviceId: asString, box: asBox }))
})

const asApproveBody = asObject({
  box: asBox,
  pukBoxes: asArray(asObject({ generation: asGeneration, box: asBox }))
})

/**
 * Chat devices, identities, per-user keys and linking (`chat/keys.ts`).
 * Every route needs a signed-in session: a machine token is refused with
 * `sessionRequired`.
 *
 * - `POST /chat/devices`, `GET /chat/devices`, `DELETE /chat/devices/:id`;
 *   `POST /chat/devices/:id/resume-challenge` and `…/resume`.
 * - `PUT /chat/identity` (enrol), `POST /chat/identity/reset`,
 *   `POST /chat/puk`.
 * - `GET /chat/me/keys`, `GET /chat/users/:userId/keys`,
 *   `GET /chat/identities/:identityId`.
 * - `POST /chat/links`, `GET /chat/links`, `GET /chat/links/:id`,
 *   `POST /chat/links/:id/approve`.
 */
export function chatKeyRoutes(
  db: Kysely<Database>,
  clock: () => Date = () => new Date()
): Router {
  const router = Router()

  router.post(
    '/chat/devices',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const body = cleanBody(asDeviceBody, req.body)
      const device = await registerDevice(db, caller, body, clock())
      setAudit(res.locals, {
        entityType: 'chatDevice',
        entityId: device.id,
        after: { name: device.name, platform: device.platform }
      })
      res.status(201).json(device)
    })
  )

  router.get(
    '/chat/devices',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      res.json(await devicesOf(db, caller))
    })
  )

  router.delete(
    '/chat/devices/:deviceId',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.deviceId)
      const device = await revokeDevice(db, caller, id, clock(), {
        keepSession: req.query.keepSession === 'true'
      })
      setAudit(res.locals, {
        entityType: 'chatDevice',
        entityId: id,
        after: { revokedAt: device.revokedAt }
      })
      res.json(device)
    })
  )

  router.post(
    '/chat/devices/:deviceId/resume-challenge',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.deviceId)
      skipAudit(res.locals)
      res.json(await resumeChallenge(db, caller, id, clock()))
    })
  )

  router.post(
    '/chat/devices/:deviceId/resume',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.deviceId)
      const body = cleanBody(asResumeBody, req.body)
      const device = await resumeDevice(db, caller, id, body, clock())
      setAudit(res.locals, {
        entityType: 'chatDevice',
        entityId: id,
        after: { resumed: true }
      })
      res.json(device)
    })
  )

  router.put(
    '/chat/identity',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const body = cleanBody(asIdentityBody, req.body)
      const made = await enrol(db, caller, body, clock())
      setAudit(res.locals, {
        entityType: 'chatIdentity',
        entityId: made.identityId,
        after: { generation: made.generation }
      })
      res.status(201).json(made)
    })
  )

  router.post(
    '/chat/identity/reset',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const body = cleanBody(asIdentityBody, req.body)
      const made = await resetIdentity(db, caller, body, clock())
      setAudit(res.locals, {
        entityType: 'chatIdentity',
        entityId: made.identityId,
        after: { reset: true, revokedDeviceIds: made.revokedDeviceIds }
      })
      res.status(201).json(made)
    })
  )

  router.post(
    '/chat/puk',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const body = cleanBody(asPukBody, req.body)
      const made = await postPuk(db, caller, body, clock())
      setAudit(res.locals, {
        entityType: 'chatUserKey',
        entityId: caller.userId,
        after: { generation: made.generation }
      })
      res.status(201).json(made)
    })
  )

  router.get(
    '/chat/me/keys',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      res.json(await myKeys(db, caller))
    })
  )

  router.get(
    '/chat/users/:userId/keys',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      let userId: string
      try {
        userId = asUserId(req.params.userId)
      } catch {
        throw notFound()
      }
      res.json(await userKeys(db, caller.userId, userId))
    })
  )

  router.get(
    '/chat/identities/:identityId',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.identityId)
      res.json(await identityById(db, caller.userId, id))
    })
  )

  router.post(
    '/chat/links',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const link = await createLink(db, caller, clock())
      setAudit(res.locals, {
        entityType: 'chatLink',
        entityId: link.id,
        after: { newDeviceId: link.newDeviceId }
      })
      res.status(201).json(link)
    })
  )

  router.get(
    '/chat/links',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      res.json(await pendingLinks(db, caller, clock()))
    })
  )

  router.get(
    '/chat/links/:linkId',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.linkId)
      res.json(await linkById(db, caller, id, clock()))
    })
  )

  router.post(
    '/chat/links/:linkId/approve',
    requireActor,
    withAsync(async (req, res) => {
      const caller = chatCaller(req.actor)
      const id = pathParam(req.params.linkId)
      const body = cleanBody(asApproveBody, req.body)
      const link = await approveLink(db, caller, id, body, clock())
      setAudit(res.locals, {
        entityType: 'chatLink',
        entityId: id,
        after: { approvedByDeviceId: link.approvedByDeviceId }
      })
      res.json(link)
    })
  )

  router.post(
    '/chat/links/:linkId/decline',
    requireActor,
    withAsync(async (req, res) => {
      const id = pathParam(req.params.linkId)
      const link = await declineLink(db, chatCaller(req.actor), id, clock())
      setAudit(res.locals, {
        entityType: 'chatLink',
        entityId: id,
        after: { declined: link.declined }
      })
      res.json(link)
    })
  )

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
