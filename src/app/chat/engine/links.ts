import type {
  ChatLink,
  ChatMyKeys,
  ChatPendingLink,
  TeamStationClient
} from '../../../common/api'
import {
  openPreviousPukKeys,
  sealPreviousPukKeys,
  signPuk,
  verifyPuk
} from '../../../common/chatCrypto/chain'
import {
  hpkeOpen,
  hpkeSeal,
  type KeyPair,
  linkAad,
  pukAad
} from '../../../common/chatCrypto/hpke'
import {
  boxPublicKey,
  newDeviceKeys,
  newIdentityKey,
  newPukKey,
  signingPublicKey
} from '../../../common/chatCrypto/keys'
import { linkCode } from '../../../common/chatCrypto/linkCode'
import { newIdentityId } from '../../../common/chatCrypto/messageIds'
import { signResume } from '../../../common/chatCrypto/resume'
import { HttpError } from '../../../common/errors'
import {
  b64,
  type ChatKeyRecord,
  type ChatKeyStore,
  latestPuk,
  newRecord,
  unb64
} from '../keyRecord'

/**
 * Enrolment, resume, linking, reset, revocation and sign-out: everything
 * that puts the user's chat keys on this device or takes them off it.
 *
 * `ensureEnrolled` runs whenever Chat or Chat devices opens. It brings the
 * device to one of three states:
 *
 * - **ready**: this device holds the user's identity and every per-user key
 *   generation, and is linked on the server. A user with no identity yet
 *   gets one here (enrolment).
 * - **link**: the user has an identity and at least one other active
 *   device, so this one asks to be linked (`startLink`, the six digits) and
 *   waits for approval (`pollLink`), or resets if those devices are out of
 *   reach.
 * - **reset**: the user has an identity and no active device left (they
 *   signed out of the only one), so the only way on is a new identity
 *   (`resetIdentity`).
 *
 * A device whose session changed resumes with a signed challenge and keeps
 * its keys. When the server refuses (`deviceRevoked`, `unknownDevice`), or
 * the stored record belongs to another user, the record is wiped and the
 * device starts again as a new one.
 */

/** The client calls the key routes need. */
export type ChatKeysClient = Pick<
  TeamStationClient,
  | 'registerChatDevice'
  | 'chatDevices'
  | 'revokeChatDevice'
  | 'chatResumeChallenge'
  | 'resumeChatDevice'
  | 'enrolChat'
  | 'resetChatIdentity'
  | 'postChatPuk'
  | 'myChatKeys'
  | 'requestChatLink'
  | 'chatLinks'
  | 'chatLink'
  | 'approveChatLink'
>

export interface ChatSetup {
  client: ChatKeysClient
  store: ChatKeyStore
  /** The signed-in user. */
  userId: number
  /** How this device names itself when it registers. */
  device: { name: string; platform: 'web' | 'ios' | 'android' }
}

export type Enrolment =
  | { state: 'ready'; record: ChatKeyRecord }
  | { state: 'link'; record: ChatKeyRecord }
  | { state: 'reset'; record: ChatKeyRecord }

/** `details.reason` of a refusal, if it carries one. */
export function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof HttpError)) return undefined
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' ? reason : undefined
}

/** Six digits as both screens show them: `123 456`. */
export function spacedCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

const inFlight = new Map<ChatKeyStore, Promise<Enrolment>>()

/**
 * Brings this device to `ready`, `link` or `reset`. Calls for one store at
 * the same time share one run, so a screen mounted twice registers one
 * device, not two.
 */
export async function ensureEnrolled(setup: ChatSetup): Promise<Enrolment> {
  const running = inFlight.get(setup.store)
  if (running != null) return await running
  const run = enrolOnce(setup).finally(() => {
    inFlight.delete(setup.store)
  })
  inFlight.set(setup.store, run)
  return await run
}

async function enrolOnce(setup: ChatSetup): Promise<Enrolment> {
  const { client, store, userId } = setup
  let record = await store.load()
  if (record != null && record.userId !== userId) {
    await store.wipe()
    record = undefined
  }
  if (record != null) {
    const mine = await bindDevice(setup, record)
    if (mine != null) return await settle(setup, record, mine)
  }
  const keys = newDeviceKeys()
  const device = await client.registerChatDevice({
    name: setup.device.name,
    platform: setup.device.platform,
    boxPublicKey: b64(keys.box.publicKey),
    signPublicKey: b64(keys.sign.publicKey)
  })
  const fresh = newRecord(userId, device.id, keys)
  await store.save(fresh)
  return await settle(setup, fresh, await client.myChatKeys())
}

/**
 * Makes sure the session is bound to the stored device, resuming it when it
 * is not. Undefined (with the record wiped) when the server will not have
 * the device back.
 */
async function bindDevice(
  setup: Pick<ChatSetup, 'client' | 'store'>,
  record: ChatKeyRecord
): Promise<ChatMyKeys | undefined> {
  const { client, store } = setup
  const mine = await client.myChatKeys()
  if (mine.deviceId === record.deviceId) return mine
  try {
    const challenge = await client.chatResumeChallenge(record.deviceId)
    const signature = signResume(
      {
        nonce: unb64(challenge.nonce),
        deviceId: record.deviceId,
        sessionId: challenge.sessionId
      },
      record.device.sign.secretKey
    )
    await client.resumeChatDevice(record.deviceId, {
      nonce: challenge.nonce,
      signature: b64(signature)
    })
  } catch (error) {
    const reason = reasonOf(error)
    if (reason === 'deviceRevoked' || reason === 'unknownDevice') {
      await store.wipe()
      return undefined
    }
    throw error
  }
  return await client.myChatKeys()
}

/** Where a bound device stands, and what it does about it. */
async function settle(
  setup: ChatSetup,
  start: ChatKeyRecord,
  mine: ChatMyKeys
): Promise<Enrolment> {
  const { client, store } = setup
  let record = start
  if (mine.identity == null) return await enrol(setup, record)
  if (record.identity?.id !== mine.identity.id) {
    // Keys of an identity that is no longer the user's (replaced by a reset
    // elsewhere, or never accepted): worth nothing, and not to be used.
    record = { ...record, identity: undefined, puks: [], epochKeys: {} }
    await store.save(record)
  }
  if (record.identity != null && mine.linked) {
    record = await syncPuks(setup, record, mine)
    if (mine.pukNeedsRotation) record = await rotatePuk(setup, record)
    return { state: 'ready', record }
  }
  if (record.pendingLinkId != null) {
    const polled = await pollLink(setup, record)
    if (polled.state === 'installed') {
      return { state: 'ready', record: polled.record }
    }
  }
  const devices = await client.chatDevices()
  const active = devices.some(
    device =>
      device.id !== record.deviceId && device.linked && device.revokedAt == null
  )
  return { state: active ? 'link' : 'reset', record }
}

function pukBox(
  record: ChatKeyRecord,
  identityId: string,
  generation: number,
  secretKey: Uint8Array,
  deviceId: string,
  deviceBoxKey: Uint8Array
): string {
  return b64(
    hpkeSeal(
      'puk',
      deviceBoxKey,
      pukAad({ userId: record.userId, identityId, generation, deviceId }),
      secretKey
    )
  )
}

/** A new identity and PUK generation 1, boxed to this device. */
function newIdentity(record: ChatKeyRecord): {
  record: ChatKeyRecord
  body: Parameters<ChatKeysClient['enrolChat']>[0]
} {
  const id = newIdentityId()
  const identity = newIdentityKey()
  const puk = newPukKey()
  const body = {
    identityId: id,
    identityPublicKey: b64(identity.publicKey),
    pukPublicKey: b64(puk.publicKey),
    pukSignature: b64(
      signPuk(
        { userId: record.userId, generation: 1, publicKey: puk.publicKey },
        identity.secretKey
      )
    ),
    box: pukBox(
      record,
      id,
      1,
      puk.secretKey,
      record.deviceId,
      record.device.box.publicKey
    )
  }
  return {
    record: {
      ...record,
      identity: { id, keys: identity },
      puks: [{ generation: 1, keys: puk }],
      pendingLinkId: undefined,
      epochKeys: {}
    },
    body
  }
}

/** The user's first identity, from this device. */
async function enrol(
  setup: ChatSetup,
  start: ChatKeyRecord
): Promise<Enrolment> {
  const { record, body } = newIdentity(start)
  // Kept before it is published: an identity the server accepted and this
  // device forgot could only be reset.
  await setup.store.save(record)
  await setup.client.enrolChat(body)
  return { state: 'ready', record }
}

/**
 * Replaces the user's identity from this device, when no linked device can
 * be reached. The server revokes every other device of the user; history
 * stays locked until other members grant it again. Every key the device
 * held before is dropped.
 */
export async function resetIdentity(
  setup: ChatSetup,
  start: ChatKeyRecord
): Promise<ChatKeyRecord> {
  const { record, body } = newIdentity(start)
  await setup.store.save(record)
  await setup.client.resetChatIdentity(body)
  return record
}

/**
 * Opens every PUK generation of the current identity this device lacks:
 * from its own boxes, and older ones through the newest generation's
 * `previousKeysBox`. Each must match its published key and signature.
 */
async function syncPuks(
  setup: ChatSetup,
  start: ChatKeyRecord,
  mine: ChatMyKeys
): Promise<ChatKeyRecord> {
  const identity = start.identity
  if (identity == null) return start
  const held = new Map(start.puks.map(puk => [puk.generation, puk.keys]))
  const before = held.size
  const published = new Map(
    mine.generations.map(generation => [generation.generation, generation])
  )
  const check = (generation: number, secretKey: Uint8Array): KeyPair => {
    const listed = published.get(generation)
    const publicKey = boxPublicKey(secretKey)
    if (
      b64(publicKey) !== listed?.publicKey ||
      !verifyPuk(
        { userId: start.userId, generation, publicKey },
        unb64(listed.signature),
        identity.keys.publicKey
      )
    ) {
      throw new Error(`Per-user key ${generation} does not match its record`)
    }
    return { secretKey, publicKey }
  }
  for (const generation of mine.generations) {
    if (held.has(generation.generation) || generation.box == null) continue
    const secretKey = hpkeOpen(
      'puk',
      start.device.box.secretKey,
      pukAad({
        userId: start.userId,
        identityId: identity.id,
        generation: generation.generation,
        deviceId: start.deviceId
      }),
      unb64(generation.box)
    )
    held.set(generation.generation, check(generation.generation, secretKey))
  }
  const newest = Math.max(0, ...held.keys())
  const carrier = published.get(newest)
  if (held.size < mine.generations.length && carrier?.previousKeysBox != null) {
    const older = openPreviousPukKeys({
      userId: start.userId,
      identityId: identity.id,
      generation: newest,
      privateKey: held.get(newest)?.secretKey ?? new Uint8Array(0),
      previousKeysBox: unb64(carrier.previousKeysBox)
    })
    for (const key of older) {
      if (!held.has(key.generation)) {
        held.set(key.generation, check(key.generation, key.privateKey))
      }
    }
  }
  if (held.size === before) return start
  const record = {
    ...start,
    puks: [...held.entries()]
      .sort(([a], [b]) => a - b)
      .map(([generation, keys]) => ({ generation, keys }))
  }
  await setup.store.save(record)
  return record
}

/**
 * Posts the next PUK generation, boxed to exactly the user's linked devices,
 * after one was revoked. When another device got there first, this one
 * takes that generation instead.
 */
export async function rotatePuk(
  setup: ChatSetup,
  start: ChatKeyRecord
): Promise<ChatKeyRecord> {
  const { client, store } = setup
  const identity = start.identity
  const current = latestPuk(start)
  if (identity == null || current == null) return start
  const devices = await client.chatDevices()
  const targets = devices.filter(
    device => device.linked && device.revokedAt == null
  )
  const generation = current.generation + 1
  const puk = newPukKey()
  try {
    await client.postChatPuk({
      generation,
      publicKey: b64(puk.publicKey),
      signature: b64(
        signPuk(
          { userId: start.userId, generation, publicKey: puk.publicKey },
          identity.keys.secretKey
        )
      ),
      previousKeysBox: b64(
        sealPreviousPukKeys({
          userId: start.userId,
          identityId: identity.id,
          generation,
          privateKey: puk.secretKey,
          older: start.puks.map(older => ({
            generation: older.generation,
            privateKey: older.keys.secretKey
          }))
        })
      ),
      boxes: targets.map(device => ({
        deviceId: device.id,
        box: pukBox(
          start,
          identity.id,
          generation,
          puk.secretKey,
          device.id,
          unb64(device.boxPublicKey)
        )
      }))
    })
  } catch (error) {
    if (reasonOf(error) !== 'generationTaken') throw error
    return await syncPuks(setup, start, await client.myChatKeys())
  }
  const record = {
    ...start,
    puks: [...start.puks, { generation, keys: puk }]
  }
  await store.save(record)
  return record
}

/** The six digits for a link this device asked for. */
export function ownLinkCode(record: ChatKeyRecord, linkId: string): string {
  return linkCode(record.device.box.publicKey, linkId)
}

/** The six digits for another device's request, as the approving device shows them. */
export function pendingLinkCode(link: ChatPendingLink): string {
  return linkCode(unb64(link.newDevice.boxPublicKey), link.id)
}

/**
 * Asks the user's linked devices to link this one, or picks up the request
 * already open. The code is what both screens show.
 */
export async function startLink(
  setup: ChatSetup,
  start: ChatKeyRecord
): Promise<{ record: ChatKeyRecord; link: ChatLink; code: string }> {
  const { client, store } = setup
  if (start.pendingLinkId != null) {
    const open = await client.chatLink(start.pendingLinkId).catch(() => null)
    if (open != null && !open.expired && !open.approved) {
      return {
        record: start,
        link: open,
        code: ownLinkCode(start, open.id)
      }
    }
  }
  const link = await client.requestChatLink()
  const record = { ...start, pendingLinkId: link.id }
  await store.save(record)
  return { record, link, code: ownLinkCode(record, link.id) }
}

export type LinkPoll =
  | { state: 'waiting' }
  | { state: 'expired'; record: ChatKeyRecord }
  | { state: 'installed'; record: ChatKeyRecord }

/**
 * Looks at this device's link request once. When it has been approved, the
 * identity key and every PUK generation are opened and kept, and the device
 * is ready.
 */
export async function pollLink(
  setup: ChatSetup,
  start: ChatKeyRecord
): Promise<LinkPoll> {
  const { client, store } = setup
  const linkId = start.pendingLinkId
  if (linkId == null) return { state: 'expired', record: start }
  let link: ChatLink
  try {
    link = await client.chatLink(linkId)
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== 'notFound') throw error
    const record = { ...start, pendingLinkId: undefined }
    await store.save(record)
    return { state: 'expired', record }
  }
  if (link.box == null) {
    if (!link.expired) return { state: 'waiting' }
    const record = { ...start, pendingLinkId: undefined }
    await store.save(record)
    return { state: 'expired', record }
  }
  const mine = await client.myChatKeys()
  if (mine.identity == null) throw new Error('The account has no identity')
  const secretKey = hpkeOpen(
    'link',
    start.device.box.secretKey,
    linkAad({ linkId, newDeviceId: start.deviceId }),
    unb64(link.box)
  )
  const publicKey = signingPublicKey(secretKey)
  if (b64(publicKey) !== mine.identity.publicKey) {
    throw new Error('The link carried a key that is not the account’s')
  }
  const installed = await syncPuks(
    setup,
    {
      ...start,
      identity: { id: mine.identity.id, keys: { secretKey, publicKey } },
      puks: [],
      pendingLinkId: undefined,
      epochKeys: {}
    },
    mine
  )
  if (installed.puks.length !== mine.generations.length) {
    throw new Error('The link did not carry every per-user key')
  }
  await store.save(installed)
  return { state: 'installed', record: installed }
}

/**
 * Approves another device's request from this linked one: the identity key
 * boxed to the new device (`link`), and every PUK generation (`puk`).
 */
export async function approveLink(
  setup: ChatSetup,
  record: ChatKeyRecord,
  link: ChatPendingLink
): Promise<void> {
  const identity = record.identity
  if (identity == null) throw new Error('This device holds no identity')
  const deviceKey = unb64(link.newDevice.boxPublicKey)
  await setup.client.approveChatLink(link.id, {
    box: b64(
      hpkeSeal(
        'link',
        deviceKey,
        linkAad({ linkId: link.id, newDeviceId: link.newDevice.id }),
        identity.keys.secretKey
      )
    ),
    pukBoxes: record.puks.map(puk => ({
      generation: puk.generation,
      box: pukBox(
        record,
        identity.id,
        puk.generation,
        puk.keys.secretKey,
        link.newDevice.id,
        deviceKey
      )
    }))
  })
}

/**
 * Removes one of the user's other devices from chat, then moves the
 * per-user key on so the removed device holds none of the current one.
 */
export async function revokeOtherDevice(
  setup: ChatSetup,
  record: ChatKeyRecord,
  deviceId: string
): Promise<ChatKeyRecord> {
  await setup.client.revokeChatDevice(deviceId)
  const mine = await setup.client.myChatKeys()
  return mine.pukNeedsRotation ? await rotatePuk(setup, record) : record
}

/**
 * Signing out: this device is removed from chat and its keys are wiped, so
 * nobody who picks it up later reads the user's chats. The wipe happens
 * whatever the server says.
 */
export async function leaveChat(
  setup: Pick<ChatSetup, 'client' | 'store'>
): Promise<void> {
  const { client, store } = setup
  try {
    const record = await store.load()
    if (record == null) return
    try {
      await client.revokeChatDevice(record.deviceId)
    } catch (error) {
      // Not bound to this session (it changed since): prove the device, then
      // remove it.
      if (reasonOf(error) == null) throw error
      await bindDevice(setup, record)
      await client.revokeChatDevice(record.deviceId)
    }
  } catch {
    // Offline, or the session already ended: the keys go all the same.
  } finally {
    await store.wipe()
  }
}
