import { type Kysely, type Selectable, sql } from 'kysely'

import { verifyPuk } from '../../common/chatCrypto/chain'
import { randomBytes } from '../../common/chatCrypto/random'
import { verifyResume } from '../../common/chatCrypto/resume'
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized
} from '../../common/errors'
import { makeId } from '../../common/ids'
import { CHAT_DEVICE_APPROVAL } from '../../common/notifications'
import type { Actor } from '../auth/sessions'
import type { ChatDevicesTable, Database } from '../db/database'
import {
  appendLog,
  inTransaction,
  notifyChat,
  notifyChatUser,
  openGrantRequests
} from './membershipLog'
import { b64 } from './wire'

/**
 * Chat devices, identities, per-user keys (PUKs) and linking.
 *
 * - **Devices** are bound to the session that registered or resumed them
 *   (`chat_devices.session_id`); a session holds at most one. A machine
 *   token has no session and cannot use chat (`sessionRequired`).
 * - **Linked.** A device is linked when it holds a PUK box at its user's
 *   current generation (the latest generation of the current identity) and
 *   is not revoked. Enrolment, link approval, reset and a new PUK generation
 *   write those boxes. A device that registered but was never approved is
 *   pending: it holds nothing.
 * - **Holders.** The routes that change keys (a new PUK generation, link
 *   approval, and in M7 epochs and grants) need the caller's session bound
 *   to a linked device of the caller (`notHolder` otherwise).
 * - Every write that changes a user's keys runs under a per-user advisory
 *   lock, so two devices never race each other to the same generation.
 *
 * Refusals carry `details.reason`: `sessionRequired`, `noDevice`,
 * `notHolder`, `unknownDevice`, `deviceRevoked`, `badChallenge`,
 * `badSignature` (403, or 400 for a PUK signature); `identityExists`,
 * `noIdentity`, `idTaken`, `generationTaken`, `alreadyLinked`,
 * `noLinkedDevice`, `linkExpired`, `linkApproved` (409); `boxSet` (400).
 */

/** How long a new device's link request stays open. */
export const LINK_LIFETIME_MS = 10 * 60_000

/** How long a resume nonce may be signed and sent back. */
export const CHALLENGE_LIFETIME_MS = 2 * 60_000

/** A signed-in caller of the chat key routes. */
export interface ChatCaller {
  userId: string
  sessionId: string
}

/** The caller, when signed in with a session; refused otherwise. */
export function chatCaller(actor: Actor | undefined): ChatCaller {
  if (actor == null) throw unauthorized()
  if (actor.sessionId == null) {
    throw forbidden('Chat needs a signed-in session, not a token', {
      reason: 'sessionRequired'
    })
  }
  return { userId: actor.userId, sessionId: actor.sessionId }
}

type DeviceRow = Selectable<ChatDevicesTable>

export type ChatPlatform = ChatDevicesTable['platform']

export interface DeviceBody {
  name: string
  platform: ChatPlatform
  boxPublicKey: Uint8Array
  signPublicKey: Uint8Array
}

/**
 * A new identity's id (made by the device, since the PUK box binds it), its
 * public key, and its first PUK, signed and boxed to this device.
 */
export interface IdentityBody {
  identityId: string
  identityPublicKey: Uint8Array
  pukPublicKey: Uint8Array
  pukSignature: Uint8Array
  box: Uint8Array
}

export interface PukBody {
  generation: number
  publicKey: Uint8Array
  signature: Uint8Array
  previousKeysBox: Uint8Array
  boxes: Array<{ deviceId: string; box: Uint8Array }>
}

export interface ApproveBody {
  box: Uint8Array
  pukBoxes: Array<{ generation: number; box: Uint8Array }>
}

export interface ChatDeviceView {
  id: string
  name: string
  platform: ChatPlatform
  boxPublicKey: string
  signPublicKey: string
  createdAt: string
  lastSeenAt: string
  revokedAt: string | null
  /** Holds a PUK box at the current generation, and is not revoked. */
  linked: boolean
  /** Bound to the caller's session. */
  current: boolean
}

export interface ChatLinkView {
  id: string
  newDeviceId: string
  createdAt: string
  expiresAt: string
  approved: boolean
  expired: boolean
  declined: boolean
  approvedByDeviceId: string | null
  /** The identity private key, HPKE-wrapped (`link`) to the new device. */
  box: string | null
}

export interface PendingLinkView {
  id: string
  newDevice: {
    id: string
    name: string
    platform: ChatPlatform
    boxPublicKey: string
  }
  createdAt: string
  expiresAt: string
}

export interface MyKeysView {
  /** The device bound to this session, if any. */
  deviceId: string | null
  linked: boolean
  identity: { id: string; publicKey: string; createdAt: string } | null
  /** Every generation of the current identity, oldest first. */
  generations: Array<{
    generation: number
    publicKey: string
    signature: string
    previousKeysBox: string | null
    /** This device's box of the generation's private key (`puk`). */
    box: string | null
  }>
  /**
   * A revoked device still holds the current generation: a linked device
   * should post the next one (`POST /chat/puk`).
   */
  pukNeedsRotation: boolean
}

export interface UserKeysView {
  userId: string
  identity: { id: string; publicKey: string; createdAt: string } | null
  puk: { generation: number; publicKey: string; signature: string } | null
}

export interface IdentityView {
  id: string
  userId: string
  publicKey: string
  createdAt: string
  replacedAt: string | null
}

export interface CurrentKeys {
  identityId: string
  identityKey: Uint8Array
  generation: number
}

const iso = (at: Date | string): string => new Date(at).toISOString()

const refuse = (reason: string, message: string): Error =>
  forbidden(message, { reason })

/** Serialises every key change of one user. */
async function lockUser(trx: Kysely<Database>, userId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`chatKeys:${userId}`}, 0))`.execute(
    trx
  )
}

/** The unrevoked device bound to the caller's session. */
async function boundDevice(
  db: Kysely<Database>,
  caller: ChatCaller
): Promise<DeviceRow | undefined> {
  return await db
    .selectFrom('chat_devices')
    .selectAll()
    .where('session_id', '=', caller.sessionId)
    .where('user_id', '=', caller.userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
}

/** The user's current identity and its latest PUK generation. */
async function currentKeys(
  db: Kysely<Database>,
  userId: string
): Promise<CurrentKeys | undefined> {
  const row = await db
    .selectFrom('chat_identities')
    .innerJoin('chat_user_keys', join =>
      join
        .onRef('chat_user_keys.identity_id', '=', 'chat_identities.id')
        .onRef('chat_user_keys.user_id', '=', 'chat_identities.user_id')
    )
    .select([
      'chat_identities.id as identityId',
      'chat_identities.identity_public_key as identityKey',
      eb => eb.fn.max('chat_user_keys.generation').as('generation')
    ])
    .where('chat_identities.user_id', '=', userId)
    .where('chat_identities.replaced_at', 'is', null)
    .groupBy(['chat_identities.id', 'chat_identities.identity_public_key'])
    .executeTakeFirst()
  if (row == null) return undefined
  return {
    identityId: row.identityId,
    identityKey: new Uint8Array(row.identityKey),
    generation: row.generation
  }
}

/** The user's linked devices: unrevoked, with a box at `keys.generation`. */
async function linkedDeviceIds(
  db: Kysely<Database>,
  userId: string,
  keys: CurrentKeys | undefined
): Promise<string[]> {
  if (keys == null) return []
  const rows = await db
    .selectFrom('chat_user_key_boxes')
    .innerJoin(
      'chat_devices',
      'chat_devices.id',
      'chat_user_key_boxes.device_id'
    )
    .select(['chat_devices.id'])
    .where('chat_user_key_boxes.user_id', '=', userId)
    .where('chat_user_key_boxes.identity_id', '=', keys.identityId)
    .where('chat_user_key_boxes.generation', '=', keys.generation)
    .where('chat_devices.revoked_at', 'is', null)
    .orderBy('chat_devices.id')
    .execute()
  return rows.map(row => row.id)
}

/**
 * The caller's session-bound device, its identity and generation, when the
 * device is linked; `notHolder` otherwise. Every route that changes keys
 * calls it inside its transaction.
 */
export async function requireHolder(
  trx: Kysely<Database>,
  caller: ChatCaller
): Promise<{ device: DeviceRow; keys: CurrentKeys }> {
  const device = await boundDevice(trx, caller)
  const keys = await currentKeys(trx, caller.userId)
  if (
    device == null ||
    keys == null ||
    !(await linkedDeviceIds(trx, caller.userId, keys)).includes(device.id)
  ) {
    throw refuse('notHolder', 'This device holds no chat keys')
  }
  return { device, keys }
}

async function requireBoundDevice(
  trx: Kysely<Database>,
  caller: ChatCaller
): Promise<DeviceRow> {
  const device = await boundDevice(trx, caller)
  if (device == null) {
    throw refuse('noDevice', 'Register this device for chat first')
  }
  return device
}

/** Every conversation the user is in now, by id. */
async function conversationIdsOf(
  trx: Kysely<Database>,
  userId: string
): Promise<string[]> {
  const rows = await trx
    .selectFrom('chat_members')
    .select(['conversation_id'])
    .where('user_id', '=', userId)
    .where('left_at', 'is', null)
    .orderBy('conversation_id')
    .execute()
  return rows.map(row => row.conversation_id)
}

async function flagRotation(
  trx: Kysely<Database>,
  conversationIds: string[]
): Promise<void> {
  if (conversationIds.length === 0) return
  await trx
    .updateTable('chat_conversations')
    .set({ needs_rotation: true })
    .where('id', 'in', conversationIds)
    .execute()
}

/** Opens a grant request in each conversation that has an epoch. */
async function openRequestsIn(
  trx: Kysely<Database>,
  conversationIds: string[],
  userId: string,
  identityReset = false
): Promise<number> {
  let opened = 0
  for (const id of conversationIds) {
    opened += await openGrantRequests(trx, id, [userId], identityReset)
  }
  return opened
}

function checkPukSignature(
  userId: string,
  generation: number,
  publicKey: Uint8Array,
  signature: Uint8Array,
  identityKey: Uint8Array
): void {
  if (!verifyPuk({ userId, generation, publicKey }, signature, identityKey)) {
    throw badRequest('The per-user key is not signed by the identity', {
      reason: 'badSignature'
    })
  }
}

/**
 * Revokes devices and kills the sessions they are bound to, unless
 * `keepSessions` (the caller's own device, whose session stays signed in).
 */
async function revokeDevices(
  trx: Kysely<Database>,
  devices: DeviceRow[],
  now: Date,
  keepSessions = false
): Promise<void> {
  if (devices.length === 0) return
  const sessions = keepSessions
    ? []
    : devices.flatMap(device =>
        device.session_id == null ? [] : [device.session_id]
      )
  await trx
    .updateTable('chat_devices')
    .set({ revoked_at: now, session_id: null })
    .where(
      'id',
      'in',
      devices.map(device => device.id)
    )
    .execute()
  if (sessions.length > 0) {
    await trx
      .updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('id', 'in', sessions)
      .where('revoked_at', 'is', null)
      .execute()
  }
}

/** Writes a new identity with PUK generation 1 boxed to `deviceId`. */
async function writeIdentity(
  trx: Kysely<Database>,
  userId: string,
  deviceId: string,
  body: IdentityBody,
  now: Date
): Promise<string> {
  const identityId = body.identityId
  const taken = await trx
    .selectFrom('chat_identities')
    .select(['id'])
    .where('id', '=', identityId)
    .executeTakeFirst()
  if (taken != null) {
    throw conflict('That identity id is taken', { reason: 'idTaken' })
  }
  await trx
    .insertInto('chat_identities')
    .values({
      id: identityId,
      user_id: userId,
      identity_public_key: body.identityPublicKey,
      created_at: now
    })
    .execute()
  await trx
    .insertInto('chat_user_keys')
    .values({
      user_id: userId,
      identity_id: identityId,
      generation: 1,
      public_key: body.pukPublicKey,
      signature: body.pukSignature,
      previous_keys_box: null,
      created_at: now
    })
    .execute()
  await trx
    .insertInto('chat_user_key_boxes')
    .values({
      user_id: userId,
      identity_id: identityId,
      generation: 1,
      device_id: deviceId,
      box: body.box,
      created_at: now
    })
    .execute()
  return identityId
}

function deviceView(
  row: DeviceRow,
  linked: string[],
  caller: ChatCaller
): ChatDeviceView {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    boxPublicKey: b64(row.box_public_key),
    signPublicKey: b64(row.sign_public_key),
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at),
    revokedAt: row.revoked_at == null ? null : iso(row.revoked_at),
    linked: linked.includes(row.id),
    current: row.revoked_at == null && row.session_id === caller.sessionId
  }
}

/** Every device of the caller's, revoked ones included, oldest first. */
export async function devicesOf(
  db: Kysely<Database>,
  caller: ChatCaller
): Promise<ChatDeviceView[]> {
  const rows = await db
    .selectFrom('chat_devices')
    .selectAll()
    .where('user_id', '=', caller.userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const linked = await linkedDeviceIds(
    db,
    caller.userId,
    await currentKeys(db, caller.userId)
  )
  return rows.map(row => deviceView(row, linked, caller))
}

async function oneDevice(
  db: Kysely<Database>,
  caller: ChatCaller,
  deviceId: string
): Promise<ChatDeviceView> {
  const views = await devicesOf(db, caller)
  const view = views.find(device => device.id === deviceId)
  if (view == null) throw notFound()
  return view
}

/**
 * `POST /chat/devices`: registers a device and binds it to the caller's
 * session (unbinding any other device from it). It holds no keys until it
 * enrols, is approved through a link, or resets.
 */
export async function registerDevice(
  db: Kysely<Database>,
  caller: ChatCaller,
  body: DeviceBody,
  now: Date
): Promise<ChatDeviceView> {
  return await inTransaction(db, async trx => {
    await lockUser(trx, caller.userId)
    const id = makeId('chatDevice')
    await trx
      .updateTable('chat_devices')
      .set({ session_id: null })
      .where('session_id', '=', caller.sessionId)
      .execute()
    await trx
      .insertInto('chat_devices')
      .values({
        id,
        user_id: caller.userId,
        session_id: caller.sessionId,
        name: body.name,
        platform: body.platform,
        box_public_key: body.boxPublicKey,
        sign_public_key: body.signPublicKey,
        created_at: now,
        last_seen_at: now
      })
      .execute()
    await notifyChatUser(trx, caller.userId, 'devices')
    return await oneDevice(trx, caller, id)
  })
}

/**
 * `DELETE /chat/devices/:id`: the owner revokes one of their devices, from
 * a linked device or from the device itself (signing out). Its session is
 * killed. When it held the current identity's keys, every conversation the
 * user is in is flagged for a new epoch, and `GET /chat/me/keys` reports
 * `pukNeedsRotation` until a linked device posts the next PUK generation.
 *
 * `keepSession` is for a device whose saved keys cannot be read any more
 * (the app's "Reset chat on this device"): it revokes the device bound to
 * the caller's session and leaves the session signed in, so the same
 * session can register a new device. It is refused (`notThisDevice`) for
 * any other device, whose session must end with it. It grants nothing a
 * session lacks: registering a device already takes the binding from the
 * old one, only without revoking it.
 */
export async function revokeDevice(
  db: Kysely<Database>,
  caller: ChatCaller,
  deviceId: string,
  now: Date,
  options: { keepSession?: boolean } = {}
): Promise<ChatDeviceView> {
  const keepSession = options.keepSession === true
  return await inTransaction(db, async trx => {
    await lockUser(trx, caller.userId)
    const target = await trx
      .selectFrom('chat_devices')
      .selectAll()
      .where('id', '=', deviceId)
      .where('user_id', '=', caller.userId)
      .executeTakeFirst()
    if (target == null) throw notFound()
    if (target.revoked_at == null) {
      const own = await boundDevice(trx, caller)
      if (own?.id !== target.id) {
        if (keepSession) {
          throw refuse(
            'notThisDevice',
            'Only the device bound to this session keeps its session'
          )
        }
        await requireHolder(trx, caller)
      }
      const keys = await currentKeys(trx, caller.userId)
      const held =
        keys != null &&
        (await trx
          .selectFrom('chat_user_key_boxes')
          .select(['generation'])
          .where('device_id', '=', target.id)
          .where('identity_id', '=', keys.identityId)
          .executeTakeFirst()) != null
      await revokeDevices(trx, [target], now, keepSession)
      if (held) {
        await flagRotation(trx, await conversationIdsOf(trx, caller.userId))
      }
      await notifyChatUser(trx, caller.userId, 'devices')
    }
    return await oneDevice(trx, caller, deviceId)
  })
}

/** The caller's device by id: `unknownDevice` or `deviceRevoked` otherwise. */
async function deviceToResume(
  db: Kysely<Database>,
  caller: ChatCaller,
  deviceId: string
): Promise<DeviceRow> {
  const device = await db
    .selectFrom('chat_devices')
    .selectAll()
    .where('id', '=', deviceId)
    .executeTakeFirst()
  if (device?.user_id !== caller.userId) {
    throw refuse('unknownDevice', 'This device is not known')
  }
  if (device.revoked_at != null) {
    throw refuse('deviceRevoked', 'This device was removed from chat')
  }
  return device
}

/**
 * `POST /chat/devices/:id/resume-challenge`: a random 32-byte nonce for the
 * device to sign with this session's id, good once and for two minutes.
 */
export async function resumeChallenge(
  db: Kysely<Database>,
  caller: ChatCaller,
  deviceId: string,
  now: Date
): Promise<{ nonce: string; sessionId: string; expiresAt: string }> {
  await deviceToResume(db, caller, deviceId)
  await db
    .deleteFrom('chat_resume_challenges')
    .where('expires_at', '<=', now)
    .execute()
  const nonce = randomBytes(32)
  const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MS)
  await db
    .insertInto('chat_resume_challenges')
    .values({
      nonce,
      device_id: deviceId,
      created_at: now,
      expires_at: expiresAt
    })
    .execute()
  return {
    nonce: b64(nonce),
    sessionId: caller.sessionId,
    expiresAt: expiresAt.toISOString()
  }
}

/**
 * `POST /chat/devices/:id/resume`: the device's Ed25519 signature over
 * `lp(nonce) ‖ lp(deviceId) ‖ lp(sessionId)` binds it to the caller's
 * session, keys and all. The nonce is spent by the attempt, whatever its
 * outcome.
 */
export async function resumeDevice(
  db: Kysely<Database>,
  caller: ChatCaller,
  deviceId: string,
  body: { nonce: Uint8Array; signature: Uint8Array },
  now: Date
): Promise<ChatDeviceView> {
  const device = await deviceToResume(db, caller, deviceId)
  const spent = await db
    .deleteFrom('chat_resume_challenges')
    .where('nonce', '=', Buffer.from(body.nonce))
    .where('device_id', '=', deviceId)
    .returning(['expires_at'])
    .executeTakeFirst()
  if (spent == null || new Date(spent.expires_at).getTime() <= now.getTime()) {
    throw refuse('badChallenge', 'Ask for a new challenge and sign that')
  }
  const signed = verifyResume(
    { nonce: body.nonce, deviceId, sessionId: caller.sessionId },
    body.signature,
    new Uint8Array(device.sign_public_key)
  )
  if (!signed) throw refuse('badSignature', 'The signature does not verify')
  return await inTransaction(db, async trx => {
    await lockUser(trx, caller.userId)
    const still = await deviceToResume(trx, caller, deviceId)
    await trx
      .updateTable('chat_devices')
      .set({ session_id: null })
      .where('session_id', '=', caller.sessionId)
      .where('id', '<>', still.id)
      .execute()
    await trx
      .updateTable('chat_devices')
      .set({ session_id: caller.sessionId, last_seen_at: now })
      .where('id', '=', still.id)
      .execute()
    await notifyChatUser(trx, caller.userId, 'devices')
    return await oneDevice(trx, caller, still.id)
  })
}

/**
 * `PUT /chat/identity`: first enrolment. The session's device publishes the
 * user's identity key and PUK generation 1 (signed by the identity) with
 * its own box of it, and so is linked. A grant request opens, with a
 * `grant` notify, in every conversation the user is in that has an epoch —
 * including DMs a merge put them in before they had an identity.
 */
export async function enrol(
  db: Kysely<Database>,
  caller: ChatCaller,
  body: IdentityBody,
  now: Date
): Promise<{ identityId: string; generation: number; grantRequests: number }> {
  return await inTransaction(db, async trx => {
    await lockUser(trx, caller.userId)
    const device = await requireBoundDevice(trx, caller)
    if ((await currentKeys(trx, caller.userId)) != null) {
      throw conflict('This user already has a chat identity', {
        reason: 'identityExists'
      })
    }
    checkPukSignature(
      caller.userId,
      1,
      body.pukPublicKey,
      body.pukSignature,
      body.identityPublicKey
    )
    const identityId = await writeIdentity(
      trx,
      caller.userId,
      device.id,
      body,
      now
    )
    const grantRequests = await openRequestsIn(
      trx,
      await conversationIdsOf(trx, caller.userId),
      caller.userId
    )
    await notifyChatUser(trx, caller.userId, 'devices')
    return { identityId, generation: 1, grantRequests }
  })
}

/**
 * `POST /chat/identity/reset`: for a user who cannot reach a linked device.
 * The device in hand publishes a new identity and PUK chain (no older keys)
 * with its own box, so it is linked from the start. In the same
 * transaction the old identity is `replaced_at`; every other device of the
 * user is revoked and its session killed; the old identity's open grant
 * requests are superseded; and in every conversation the user is in an
 * `identityReset` row is logged, a new epoch is flagged, and a grant
 * request marked `identity_reset` opens (when it has an epoch), which only
 * an approver may fill.
 */
export async function resetIdentity(
  db: Kysely<Database>,
  caller: ChatCaller,
  body: IdentityBody,
  now: Date
): Promise<{
  identityId: string
  generation: number
  revokedDeviceIds: string[]
}> {
  return await inTransaction(db, async trx => {
    await lockUser(trx, caller.userId)
    const device = await requireBoundDevice(trx, caller)
    const old = await currentKeys(trx, caller.userId)
    if (old == null) {
      throw conflict('There is no identity to reset; enrol instead', {
        reason: 'noIdentity'
      })
    }
    checkPukSignature(
      caller.userId,
      1,
      body.pukPublicKey,
      body.pukSignature,
      body.identityPublicKey
    )
    await trx
      .updateTable('chat_identities')
      .set({ replaced_at: now })
      .where('id', '=', old.identityId)
      .execute()
    const identityId = await writeIdentity(
      trx,
      caller.userId,
      device.id,
      body,
      now
    )
    const others = await trx
      .selectFrom('chat_devices')
      .selectAll()
      .where('user_id', '=', caller.userId)
      .where('id', '<>', device.id)
      .where('revoked_at', 'is', null)
      .orderBy('id')
      .execute()
    await revokeDevices(trx, others, now)
    // Every undecided request belonged to the old identity, including one
    // from the device doing the reset. Earlier decisions remain history.
    await trx
      .updateTable('chat_links')
      .set({ expires_at: now })
      .where('user_id', '=', caller.userId)
      .where('box', 'is', null)
      .where('declined_at', 'is', null)
      .where('expires_at', '>', now)
      .execute()
    await trx
      .updateTable('chat_grant_requests')
      .set({ superseded_at: now })
      .where('user_id', '=', caller.userId)
      .where('identity_id', '=', old.identityId)
      .where('filled_at', 'is', null)
      .where('superseded_at', 'is', null)
      .execute()
    const conversations = await conversationIdsOf(trx, caller.userId)
    for (const id of conversations) {
      await trx
        .selectFrom('chat_conversations')
        .select(['id'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      await appendLog(
        trx,
        id,
        [
          {
            event: 'identityReset',
            userId: caller.userId,
            actorUserId: caller.userId,
            reason: null
          }
        ],
        now
      )
      await openGrantRequests(trx, id, [caller.userId], true)
      await notifyChat(trx, id, 'members')
    }
    await flagRotation(trx, conversations)
    await notifyChatUser(trx, caller.userId, 'devices')
    return {
      identityId,
      generation: 1,
      revokedDeviceIds: others.map(other => other.id)
    }
  })
}

/**
 * `POST /chat/puk`: a linked device posts PUK generation n+1, signed by the
 * current identity, carrying the older private keys, and boxed to exactly
 * the user's linked devices at generation n (`boxSet` otherwise; a pending
 * or revoked device is never among them). Every conversation the user is in
 * is flagged for a new epoch, and grant requests open at the new
 * generation where there is an epoch, superseding the user's open requests
 * at older generations. Where the superseded request awaited an approver
 * after an identity reset, so does the new one.
 */
export async function postPuk(
  db: Kysely<Database>,
  caller: ChatCaller,
  body: PukBody,
  now: Date
): Promise<{ generation: number; grantRequests: number }> {
  return await inTransaction(db, async trx => {
    await lockUser(trx, caller.userId)
    const { keys } = await requireHolder(trx, caller)
    if (body.generation !== keys.generation + 1) {
      throw conflict(`The next generation is ${keys.generation + 1}`, {
        reason: 'generationTaken'
      })
    }
    checkPukSignature(
      caller.userId,
      body.generation,
      body.publicKey,
      body.signature,
      keys.identityKey
    )
    const expected = await linkedDeviceIds(trx, caller.userId, keys)
    const named = body.boxes.map(box => box.deviceId).sort()
    if (
      new Set(named).size !== named.length ||
      named.join(' ') !== [...expected].sort().join(' ')
    ) {
      throw badRequest('Box the new key to exactly the linked devices', {
        reason: 'boxSet'
      })
    }
    await trx
      .insertInto('chat_user_keys')
      .values({
        user_id: caller.userId,
        identity_id: keys.identityId,
        generation: body.generation,
        public_key: body.publicKey,
        signature: body.signature,
        previous_keys_box: body.previousKeysBox,
        created_at: now
      })
      .execute()
    await trx
      .insertInto('chat_user_key_boxes')
      .values(
        body.boxes.map(box => ({
          user_id: caller.userId,
          identity_id: keys.identityId,
          generation: body.generation,
          device_id: box.deviceId,
          box: box.box,
          created_at: now
        }))
      )
      .execute()
    // A request at an older generation would box an epoch key to a
    // generation a revoked device may still hold; the new one replaces it,
    // and still waits for an approver where the old one did.
    const superseded = await trx
      .updateTable('chat_grant_requests')
      .set({ superseded_at: now })
      .where('user_id', '=', caller.userId)
      .where('identity_id', '=', keys.identityId)
      .where('generation', '<', body.generation)
      .where('filled_at', 'is', null)
      .where('superseded_at', 'is', null)
      .returning(['conversation_id', 'identity_reset'])
      .execute()
    const awaitingApproval = new Set(
      superseded
        .filter(row => row.identity_reset)
        .map(row => row.conversation_id)
    )
    const conversations = await conversationIdsOf(trx, caller.userId)
    await flagRotation(trx, conversations)
    const grantRequests =
      (await openRequestsIn(
        trx,
        conversations.filter(id => !awaitingApproval.has(id)),
        caller.userId
      )) +
      (await openRequestsIn(
        trx,
        conversations.filter(id => awaitingApproval.has(id)),
        caller.userId,
        true
      ))
    await notifyChatUser(trx, caller.userId, 'devices')
    return { generation: body.generation, grantRequests }
  })
}

/** `GET /chat/me/keys`: my identity, PUK generations, and this device's boxes. */
export async function myKeys(
  db: Kysely<Database>,
  caller: ChatCaller
): Promise<MyKeysView> {
  const device = await boundDevice(db, caller)
  const keys = await currentKeys(db, caller.userId)
  const linked = await linkedDeviceIds(db, caller.userId, keys)
  if (keys == null) {
    return {
      deviceId: device?.id ?? null,
      linked: false,
      identity: null,
      generations: [],
      pukNeedsRotation: false
    }
  }
  const identity = await db
    .selectFrom('chat_identities')
    .select(['id', 'identity_public_key', 'created_at'])
    .where('id', '=', keys.identityId)
    .executeTakeFirstOrThrow()
  const generations = await db
    .selectFrom('chat_user_keys')
    .leftJoin('chat_user_key_boxes', join =>
      join
        .onRef('chat_user_key_boxes.user_id', '=', 'chat_user_keys.user_id')
        .onRef(
          'chat_user_key_boxes.identity_id',
          '=',
          'chat_user_keys.identity_id'
        )
        .onRef(
          'chat_user_key_boxes.generation',
          '=',
          'chat_user_keys.generation'
        )
        .on('chat_user_key_boxes.device_id', '=', device?.id ?? '')
    )
    .select([
      'chat_user_keys.generation',
      'chat_user_keys.public_key',
      'chat_user_keys.signature',
      'chat_user_keys.previous_keys_box',
      'chat_user_key_boxes.box'
    ])
    .where('chat_user_keys.user_id', '=', caller.userId)
    .where('chat_user_keys.identity_id', '=', keys.identityId)
    .orderBy('chat_user_keys.generation')
    .execute()
  const stale = await db
    .selectFrom('chat_user_key_boxes')
    .innerJoin(
      'chat_devices',
      'chat_devices.id',
      'chat_user_key_boxes.device_id'
    )
    .select(['chat_devices.id'])
    .where('chat_user_key_boxes.user_id', '=', caller.userId)
    .where('chat_user_key_boxes.identity_id', '=', keys.identityId)
    .where('chat_user_key_boxes.generation', '=', keys.generation)
    .where('chat_devices.revoked_at', 'is not', null)
    .executeTakeFirst()
  return {
    deviceId: device?.id ?? null,
    linked: device != null && linked.includes(device.id),
    identity: {
      id: identity.id,
      publicKey: b64(identity.identity_public_key),
      createdAt: iso(identity.created_at)
    },
    generations: generations.map(row => ({
      generation: row.generation,
      publicKey: b64(row.public_key),
      signature: b64(row.signature),
      previousKeysBox:
        row.previous_keys_box == null ? null : b64(row.previous_keys_box),
      box: row.box == null ? null : b64(row.box)
    })),
    pukNeedsRotation: stale != null
  }
}

/**
 * Whether `callerId` may read `userId`'s keys: themselves, or somebody who
 * is or was a member of a conversation the caller is in now.
 */
async function reaches(
  db: Kysely<Database>,
  callerId: string,
  userId: string
): Promise<boolean> {
  if (callerId === userId) return true
  const row = await db
    .selectFrom('chat_members as mine')
    .innerJoin(
      'chat_members as theirs',
      'theirs.conversation_id',
      'mine.conversation_id'
    )
    .select(['mine.conversation_id'])
    .where('mine.user_id', '=', callerId)
    .where('mine.left_at', 'is', null)
    .where('theirs.user_id', '=', userId)
    .limit(1)
    .executeTakeFirst()
  return row != null
}

/** `GET /chat/users/:userId/keys`: a reachable user's current identity and PUK. */
export async function userKeys(
  db: Kysely<Database>,
  callerId: string,
  userId: string
): Promise<UserKeysView> {
  if (!(await reaches(db, callerId, userId))) throw notFound()
  const keys = await currentKeys(db, userId)
  if (keys == null) return { userId, identity: null, puk: null }
  const identity = await db
    .selectFrom('chat_identities')
    .select(['created_at'])
    .where('id', '=', keys.identityId)
    .executeTakeFirstOrThrow()
  const puk = await db
    .selectFrom('chat_user_keys')
    .select(['public_key', 'signature'])
    .where('user_id', '=', userId)
    .where('identity_id', '=', keys.identityId)
    .where('generation', '=', keys.generation)
    .executeTakeFirstOrThrow()
  return {
    userId,
    identity: {
      id: keys.identityId,
      publicKey: b64(keys.identityKey),
      createdAt: iso(identity.created_at)
    },
    puk: {
      generation: keys.generation,
      publicKey: b64(puk.public_key),
      signature: b64(puk.signature)
    }
  }
}

/** `GET /chat/identities/:identityId`: any identity, current or replaced, of a reachable user. */
export async function identityById(
  db: Kysely<Database>,
  callerId: string,
  identityId: string
): Promise<IdentityView> {
  const row = await db
    .selectFrom('chat_identities')
    .selectAll()
    .where('id', '=', identityId)
    .executeTakeFirst()
  if (row == null || !(await reaches(db, callerId, row.user_id))) {
    throw notFound()
  }
  return {
    id: row.id,
    userId: row.user_id,
    publicKey: b64(row.identity_public_key),
    createdAt: iso(row.created_at),
    replacedAt: row.replaced_at == null ? null : iso(row.replaced_at)
  }
}

function linkView(
  row: {
    id: string
    new_device_id: string
    approved_by_device_id: string | null
    box: Uint8Array | null
    declined_at: Date | null
    created_at: Date
    expires_at: Date
  },
  now: Date
): ChatLinkView {
  const approved = row.box != null
  return {
    id: row.id,
    newDeviceId: row.new_device_id,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    approved,
    declined: row.declined_at != null,
    expired:
      !approved &&
      row.declined_at == null &&
      new Date(row.expires_at).getTime() <= now.getTime(),
    approvedByDeviceId: row.approved_by_device_id,
    box: row.box == null ? null : b64(row.box)
  }
}

/**
 * `POST /chat/links`: the session's device, not yet linked, asks the user's
 * linked devices for the identity. Needs an identity and another linked
 * device (`noIdentity`, `noLinkedDevice` otherwise: reset instead). Lasts
 * ten minutes.
 */
export async function createLink(
  db: Kysely<Database>,
  caller: ChatCaller,
  now: Date
): Promise<ChatLinkView> {
  return await inTransaction(db, async trx => {
    await lockUser(trx, caller.userId)
    const device = await requireBoundDevice(trx, caller)
    const keys = await currentKeys(trx, caller.userId)
    if (keys == null) {
      throw conflict('There is no identity to link to; enrol instead', {
        reason: 'noIdentity'
      })
    }
    const linked = await linkedDeviceIds(trx, caller.userId, keys)
    if (linked.includes(device.id)) {
      throw conflict('This device is already linked', {
        reason: 'alreadyLinked'
      })
    }
    if (linked.length === 0) {
      throw conflict('No linked device is left to approve this', {
        reason: 'noLinkedDevice'
      })
    }
    const pending = await trx
      .selectFrom('chat_links')
      .selectAll()
      .where('new_device_id', '=', device.id)
      .where('box', 'is', null)
      .where('declined_at', 'is', null)
      .where('expires_at', '>', now)
      .orderBy('created_at')
      .executeTakeFirst()
    if (pending != null) return linkView(pending, now)
    const row = await trx
      .insertInto('chat_links')
      .values({
        id: makeId('chatLink'),
        user_id: caller.userId,
        new_device_id: device.id,
        created_at: now,
        expires_at: new Date(now.getTime() + LINK_LIFETIME_MS)
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('notification_events')
      .values({
        id: makeId('audit'),
        source_type: CHAT_DEVICE_APPROVAL,
        source_id: row.id,
        revision: 1,
        actor_id: caller.userId,
        metadata: {
          title: 'Approve chat device',
          description: `${device.name} (${device.platform}) asks to read your chats.`
        },
        recorded_recipients: [caller.userId],
        created_at: now
      })
      .execute()
    await notifyChatUser(trx, caller.userId, 'link')
    return linkView(row, now)
  })
}

/** `GET /chat/links`: the caller's open link requests, from unrevoked devices. */
export async function pendingLinks(
  db: Kysely<Database>,
  caller: ChatCaller,
  now: Date
): Promise<PendingLinkView[]> {
  const rows = await db
    .selectFrom('chat_links')
    .innerJoin('chat_devices', 'chat_devices.id', 'chat_links.new_device_id')
    .select([
      'chat_links.id',
      'chat_links.created_at',
      'chat_links.expires_at',
      'chat_devices.id as deviceId',
      'chat_devices.name',
      'chat_devices.platform',
      'chat_devices.box_public_key'
    ])
    .where('chat_links.user_id', '=', caller.userId)
    .where('chat_links.box', 'is', null)
    .where('chat_links.declined_at', 'is', null)
    .where('chat_links.expires_at', '>', now)
    .where('chat_devices.revoked_at', 'is', null)
    .orderBy('chat_links.created_at')
    .orderBy('chat_links.id')
    .execute()
  return rows.map(row => ({
    id: row.id,
    newDevice: {
      id: row.deviceId,
      name: row.name,
      platform: row.platform,
      boxPublicKey: b64(row.box_public_key)
    },
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at)
  }))
}

/** `GET /chat/links/:id`: one of the caller's links, with its box once approved. */
export async function linkById(
  db: Kysely<Database>,
  caller: ChatCaller,
  linkId: string,
  now: Date
): Promise<ChatLinkView> {
  const row = await db
    .selectFrom('chat_links')
    .selectAll()
    .where('id', '=', linkId)
    .where('user_id', '=', caller.userId)
    .executeTakeFirst()
  if (row == null) throw notFound()
  return linkView(row, now)
}

/**
 * `POST /chat/links/:id/approve`: a linked device of the same user hands
 * the new device the identity private key (`box`, HPKE `link`) and one PUK
 * box per generation of the current identity (HPKE `puk`; `boxSet`
 * otherwise), which makes the new device linked.
 */
export async function approveLink(
  db: Kysely<Database>,
  caller: ChatCaller,
  linkId: string,
  body: ApproveBody,
  now: Date
): Promise<ChatLinkView> {
  return await inTransaction(db, async trx => {
    await lockUser(trx, caller.userId)
    const link = await trx
      .selectFrom('chat_links')
      .selectAll()
      .where('id', '=', linkId)
      .where('user_id', '=', caller.userId)
      .executeTakeFirst()
    if (link == null) throw notFound()
    const { device, keys } = await requireHolder(trx, caller)
    if (link.box != null) {
      return linkView(link, now)
    }
    if (link.declined_at != null) {
      throw conflict('This link was declined', { reason: 'linkDeclined' })
    }
    if (new Date(link.expires_at).getTime() <= now.getTime()) {
      throw conflict('This link expired; ask again from the new device', {
        reason: 'linkExpired'
      })
    }
    const newDevice = await trx
      .selectFrom('chat_devices')
      .select(['id', 'revoked_at'])
      .where('id', '=', link.new_device_id)
      .executeTakeFirstOrThrow()
    if (newDevice.revoked_at != null) {
      throw refuse('deviceRevoked', 'The new device was removed from chat')
    }
    if (newDevice.id === device.id) {
      throw conflict('This device is already linked', {
        reason: 'alreadyLinked'
      })
    }
    const generations = Array.from(
      { length: keys.generation },
      (_, index) => index + 1
    )
    const named = body.pukBoxes.map(box => box.generation).sort((a, b) => a - b)
    if (named.join(' ') !== generations.join(' ')) {
      throw badRequest('Box every generation of the per-user key once', {
        reason: 'boxSet'
      })
    }
    await trx
      .updateTable('chat_links')
      .set({ box: body.box, approved_by_device_id: device.id })
      .where('id', '=', link.id)
      .execute()
    await trx
      .insertInto('chat_user_key_boxes')
      .values(
        body.pukBoxes.map(box => ({
          user_id: caller.userId,
          identity_id: keys.identityId,
          generation: box.generation,
          device_id: newDevice.id,
          box: box.box,
          created_at: now
        }))
      )
      .onConflict(oc =>
        oc
          .columns(['user_id', 'identity_id', 'generation', 'device_id'])
          .doUpdateSet(eb => ({ box: eb.ref('excluded.box') }))
      )
      .execute()
    await notifyChatUser(trx, caller.userId, 'link')
    await notifyChatUser(trx, caller.userId, 'devices')
    const approved = await trx
      .selectFrom('chat_links')
      .selectAll()
      .where('id', '=', link.id)
      .executeTakeFirstOrThrow()
    return linkView(approved, now)
  })
}

/** First decision wins under the same user lock as approval and revocation. */
export async function declineLink(
  db: Kysely<Database>,
  caller: ChatCaller,
  linkId: string,
  now: Date
): Promise<ChatLinkView> {
  return await inTransaction(db, async trx => {
    await lockUser(trx, caller.userId)
    await requireHolder(trx, caller)
    const link = await trx
      .selectFrom('chat_links')
      .selectAll()
      .where('id', '=', linkId)
      .where('user_id', '=', caller.userId)
      .executeTakeFirst()
    if (link == null) throw notFound()
    if (link.box != null)
      throw conflict('This link was already approved', {
        reason: 'linkApproved'
      })
    if (link.declined_at != null) return linkView(link, now)
    if (new Date(link.expires_at).getTime() <= now.getTime())
      throw conflict('This link expired', { reason: 'linkExpired' })
    const device = await trx
      .selectFrom('chat_devices')
      .select('revoked_at')
      .where('id', '=', link.new_device_id)
      .executeTakeFirstOrThrow()
    if (device.revoked_at != null)
      throw refuse('deviceRevoked', 'The new device was removed from chat')
    const declined = await trx
      .updateTable('chat_links')
      .set({ declined_at: now })
      .where('id', '=', linkId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await notifyChatUser(trx, caller.userId, 'link')
    return linkView(declined, now)
  })
}
