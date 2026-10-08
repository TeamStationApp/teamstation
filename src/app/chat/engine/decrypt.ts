import type {
  ChatEpoch,
  ChatEpochs,
  ChatIdentity,
  ChatMessage
} from '../../../common/api'
import { type ChatContent, decodeContent } from '../../../common/chatContent'
import {
  openPreviousEpochKey,
  verifyEpoch
} from '../../../common/chatCrypto/chain'
import { ChatCryptoUnavailable } from '../../../common/chatCrypto/coreCall'
import { epochAad, hpkeOpen } from '../../../common/chatCrypto/hpke'
import {
  type MessageFields,
  messageKey,
  openWithMessageKey,
  verifyMessage
} from '../../../common/chatCrypto/seal'
import { HttpError } from '../../../common/errors'
import { epochKeyOf, pinIdentity, unb64, withEpochKey } from '../keyRecord'
import type { ChatEngineClient, EngineContext } from './context'
import type { ConversationState } from './store'

/**
 * Checking and opening what the server hands over.
 *
 * - Every epoch is checked against the identity that signed it
 *   (`chat_epochs.identity_id`, read with `GET /chat/identities/:id`), and
 *   its key opened from this device's box or down the chain from a later
 *   epoch's.
 * - Every message is checked against the identity its `senderIdentityId`
 *   names, which must be the sender's, before anything is opened. A message
 *   signed by an identity since replaced still verifies, and is marked as
 *   sent before the person's safety number changed: the pinned key is
 *   compared only with a person's *current* identity.
 */

/** What one envelope opened to. */
export type Opened =
  | { status: 'ok'; content: ChatContent; replacedIdentity: boolean }
  /** No key for its epoch yet; a grant may still bring one. */
  | { status: 'locked' }
  /** Before a chain break this device holds no key across: never readable. */
  | { status: 'lost' }
  /** Deleted: the server emptied it. */
  | { status: 'cleared' }
  | {
      status: 'invalid'
      reason: 'identity' | 'signature' | 'epoch' | 'content'
    }

/** Identities by id, each read once a session. */
export class IdentityCache {
  private readonly pending = new Map<string, Promise<ChatIdentity>>()
  private readonly known = new Map<string, ChatIdentity>()

  constructor(
    private readonly client: Pick<ChatEngineClient, 'chatIdentity'>
  ) {}

  async get(identityId: string): Promise<ChatIdentity> {
    const known = this.known.get(identityId)
    if (known != null) return known
    let pending = this.pending.get(identityId)
    if (pending == null) {
      pending = this.client.chatIdentity(identityId).then(
        identity => {
          this.known.set(identityId, identity)
          this.pending.delete(identityId)
          return identity
        },
        (error: unknown) => {
          this.pending.delete(identityId)
          throw error
        }
      )
      this.pending.set(identityId, pending)
    }
    return await pending
  }

  /** Forgets a person's identities, so whether each is current is read again. */
  forgetUser(userId: number): void {
    for (const [id, identity] of this.known) {
      if (identity.userId === userId) this.known.delete(id)
    }
  }
}

const isNotFound = (error: unknown): boolean =>
  error instanceof HttpError && error.code === 'notFound'

/** An identity, or undefined when the server says there is none to see. */
async function identityOf(
  ctx: EngineContext,
  identityId: string
): Promise<ChatIdentity | undefined> {
  try {
    return await ctx.identities.get(identityId)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/**
 * Pins a person's current identity key (trust on first use). A change is
 * reported to the screens, and their identities are read again.
 */
export async function pinCurrent(
  ctx: EngineContext,
  userId: number,
  identityKey: string
): Promise<'new' | 'same' | 'changed'> {
  if (userId === ctx.userId) return 'same'
  const seen: { value: 'new' | 'same' | 'changed' } = { value: 'same' }
  await ctx.keys.update(record => {
    const pinned = pinIdentity(record, userId, unb64(identityKey))
    seen.value = pinned.seen
    return pinned.record
  })
  if (seen.value === 'changed') {
    ctx.identities.forgetUser(userId)
    ctx.memory.emit({ type: 'safetyNumber', userId })
  }
  return seen.value
}

/** Whether an epoch's record is what its creator signed, and well formed. */
export async function checkEpoch(
  ctx: EngineContext,
  conversationId: string,
  epoch: ChatEpoch
): Promise<boolean> {
  const box = epoch.previousKeyBox == null ? null : unb64(epoch.previousKeyBox)
  const shaped =
    epoch.epoch === 1
      ? !epoch.chainBreak && box == null
      : epoch.chainBreak === (box == null)
  if (!shaped) return false
  const identity = await identityOf(ctx, epoch.identityId)
  if (identity?.userId !== epoch.createdByUserId) return false
  return verifyEpoch(
    { conversationId, epoch: epoch.epoch, previousKeyBox: box },
    unb64(epoch.signature),
    unb64(identity.publicKey)
  )
}

/** Checks newly read epochs and keeps them in the chat's state. */
export async function takeEpochs(
  ctx: EngineContext,
  conversationId: string,
  state: ConversationState,
  epochs: ChatEpoch[]
): Promise<void> {
  for (const epoch of epochs) {
    state.epochs.set(epoch.epoch, {
      record: epoch,
      valid: await checkEpoch(ctx, conversationId, epoch)
    })
  }
}

/**
 * Opens every epoch key this device's boxes give it, then walks each key it
 * holds down the chain (`previous_key_box`) as far as the chain goes. Keeps
 * what it opened in the key record. Answers `needKeys` when a box is for a
 * per-user key generation this device does not hold yet.
 */
export async function openEpochKeys(
  ctx: EngineContext,
  conversationId: string,
  state: ConversationState,
  boxes: ChatEpochs['boxes']
): Promise<{ opened: number; needKeys: boolean }> {
  const record = ctx.keys.record
  const identity = record.identity
  if (identity == null) return { opened: 0, needKeys: false }
  const found = new Map<number, Uint8Array>()
  const have = (epoch: number): Uint8Array | undefined =>
    found.get(epoch) ?? epochKeyOf(record, conversationId, epoch)
  let needKeys = false
  for (const box of boxes) {
    if (box.identityId !== identity.id || have(box.epoch) != null) continue
    const puk = record.puks.find(held => held.generation === box.pukGeneration)
    if (puk == null) {
      needKeys = true
      continue
    }
    try {
      const key = hpkeOpen(
        box.grantedByUserId == null ? 'epoch' : 'grant',
        puk.keys.secretKey,
        epochAad({
          conversationId,
          epoch: box.epoch,
          recipientUserId: ctx.userId,
          identityId: identity.id,
          generation: box.pukGeneration
        }),
        unb64(box.box)
      )
      if (key.length === 32) found.set(box.epoch, key)
    } catch (error) {
      if (error instanceof ChatCryptoUnavailable) throw error
      // A box that does not open is no key; the chat stays locked.
    }
  }
  const numbers = [...state.epochs.keys()].sort((a, b) => b - a)
  for (const number of numbers) {
    const epoch = state.epochs.get(number)
    const key = have(number)
    if (
      epoch == null ||
      key == null ||
      !epoch.valid ||
      epoch.record.previousKeyBox == null ||
      have(number - 1) != null
    ) {
      continue
    }
    try {
      found.set(
        number - 1,
        openPreviousEpochKey({
          conversationId,
          epoch: number,
          epochKey: key,
          previousKeyBox: unb64(epoch.record.previousKeyBox)
        })
      )
    } catch (error) {
      if (error instanceof ChatCryptoUnavailable) throw error
      // A broken link: what lies below it stays closed.
    }
  }
  if (found.size > 0) {
    await ctx.keys.update(start => {
      let next = start
      for (const [epoch, key] of found) {
        next = withEpochKey(next, conversationId, epoch, key)
      }
      return next
    })
  }
  return { opened: found.size, needKeys }
}

/** Locked for now, or lost for good behind a chain break. */
function withoutKey(state: ConversationState, epoch: number): Opened {
  for (const [number, held] of state.epochs) {
    if (number > epoch && held.record.chainBreak) return { status: 'lost' }
  }
  return { status: 'locked' }
}

/** Which content type each envelope kind must carry. */
const CONTENT_OF: Record<ChatMessage['kind'], ChatContent['type']> = {
  post: 'text',
  reaction: 'reaction',
  edit: 'edit',
  delete: 'delete',
  moderatorDelete: 'delete'
}

/** The AAD fields of an envelope. */
export function fieldsOf(envelope: ChatMessage): MessageFields {
  return {
    conversationId: envelope.conversationId,
    epoch: envelope.epoch,
    messageId: envelope.id,
    senderUserId: envelope.senderUserId,
    kind: envelope.kind
  }
}

/** Verifies one envelope against its sender's identity, then opens it. */
export async function openEnvelope(
  ctx: EngineContext,
  state: ConversationState,
  envelope: ChatMessage
): Promise<Opened> {
  if (envelope.clearedAt != null || envelope.ciphertext === '') {
    return { status: 'cleared' }
  }
  const epochKey = epochKeyOf(
    ctx.keys.record,
    envelope.conversationId,
    envelope.epoch
  )
  if (epochKey == null) return withoutKey(state, envelope.epoch)
  if (state.epochs.get(envelope.epoch)?.valid !== true) {
    return { status: 'invalid', reason: 'epoch' }
  }
  const identity = await identityOf(ctx, envelope.senderIdentityId)
  if (identity?.userId !== envelope.senderUserId) {
    return { status: 'invalid', reason: 'identity' }
  }
  const fields = fieldsOf(envelope)
  const sealed = {
    nonce: unb64(envelope.nonce),
    ciphertext: unb64(envelope.ciphertext),
    signature: unb64(envelope.signature)
  }
  if (
    !verifyMessage({
      ...fields,
      ...sealed,
      senderIdentityKey: unb64(identity.publicKey)
    })
  ) {
    return { status: 'invalid', reason: 'signature' }
  }
  let content: ChatContent
  try {
    content = decodeContent(
      openWithMessageKey({
        ...fields,
        ...sealed,
        messageKey: messageKey(epochKey, fields.conversationId, envelope.id)
      })
    )
  } catch (error) {
    if (error instanceof ChatCryptoUnavailable) throw error
    return { status: 'invalid', reason: 'content' }
  }
  if (
    content.type !== CONTENT_OF[envelope.kind] ||
    (content.type === 'delete' &&
      !(envelope.targetIds ?? []).includes(content.targetId))
  ) {
    return { status: 'invalid', reason: 'content' }
  }
  if (identity.replacedAt == null) {
    await pinCurrent(ctx, identity.userId, identity.publicKey)
  }
  return {
    status: 'ok',
    content,
    replacedIdentity: identity.replacedAt != null
  }
}
