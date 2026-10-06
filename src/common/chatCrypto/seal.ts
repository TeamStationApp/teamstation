import { join, lp, u64, utf8 } from './bytes'
import { call } from './core'
import { num, readFlag, readNumber } from './coreCall'
import { sha256 } from './hash'

/**
 * One message, sealed and signed, on the chat crypto core.
 *
 * - The message key is `HKDF-SHA256(epochKey, salt = conversationId,
 *   info = "ts-chat/v1/msg" ‖ messageId)` (both strings as UTF-8), so each
 *   message has its own key, and a reporter can hand the server that one key
 *   without the epoch's.
 * - The cipher is XChaCha20-Poly1305 with a random 24-byte nonce, over the
 *   content padded to its bucket (`bucketSize`), with AAD
 *   `lp(conversationId) ‖ u64(epoch) ‖ lp(messageId) ‖ u64(senderUserId) ‖
 *   lp(kind)`.
 * - The sender's identity key signs `SHA-256(aad ‖ nonce ‖ ciphertext)`.
 */

/** The envelope kinds, which the server sees. */
export type EnvelopeKind =
  'post' | 'reaction' | 'edit' | 'delete' | 'moderatorDelete'

export const ENVELOPE_KINDS: readonly EnvelopeKind[] = [
  'post',
  'reaction',
  'edit',
  'delete',
  'moderatorDelete'
]

/** What a message's AAD binds it to. */
export interface MessageFields {
  conversationId: string
  epoch: number
  messageId: string
  senderUserId: number
  kind: EnvelopeKind
}

export interface SealedMessage {
  nonce: Uint8Array
  ciphertext: Uint8Array
  signature: Uint8Array
}

const EMPTY = new Uint8Array(0)

/**
 * The padded size of `length` bytes of plaintext:
 * `max(541, ceil(1.05^ceil(log_1.05(length + 1))))`, the `+ 1` being the
 * `0x80` that marks where the padding starts. Computed exactly in the core,
 * so a phone and a server never disagree on a bucket's edge.
 */
export function bucketSize(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Not a length: ${length}`)
  }
  return readNumber(call('bucketSize', [num(length)])[0])
}

export function messageAad(fields: MessageFields): Uint8Array {
  return join(
    lp(fields.conversationId),
    u64(fields.epoch),
    lp(fields.messageId),
    u64(fields.senderUserId),
    lp(fields.kind)
  )
}

/** The core's arguments for a message's fields, in the order its ops take them. */
const fieldArgs = (fields: MessageFields): Uint8Array[] => [
  utf8(fields.conversationId),
  num(fields.epoch),
  utf8(fields.messageId),
  num(fields.senderUserId),
  utf8(fields.kind)
]

/** This one message's key, from the epoch key. */
export function messageKey(
  epochKey: Uint8Array,
  conversationId: string,
  messageId: string
): Uint8Array {
  return call('messageKey', [
    epochKey,
    utf8(conversationId),
    utf8(messageId)
  ])[0]
}

/** What the identity key signs: `SHA-256(aad ‖ nonce ‖ ciphertext)`. */
export function signedDigest(
  aad: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  return sha256(join(aad, nonce, ciphertext))
}

/** Pads, seals and signs a message's content (its UTF-8 JSON). */
export function sealMessage(
  fields: MessageFields & {
    epochKey: Uint8Array
    plaintext: Uint8Array
    identitySecretKey: Uint8Array
    /** Only tests pass one. */
    nonce?: Uint8Array
  }
): SealedMessage {
  const [nonce, ciphertext, signature] = call('sealMessage', [
    ...fieldArgs(fields),
    fields.epochKey,
    fields.plaintext,
    fields.identitySecretKey,
    fields.nonce ?? EMPTY
  ])
  return { nonce, ciphertext, signature }
}

/** Whether the signature is the sender identity's over this envelope. */
export function verifyMessage(
  fields: MessageFields & SealedMessage & { senderIdentityKey: Uint8Array }
): boolean {
  return readFlag(
    call('verifyMessage', [
      ...fieldArgs(fields),
      fields.nonce,
      fields.ciphertext,
      fields.signature,
      fields.senderIdentityKey
    ])[0]
  )
}

/**
 * The content of a message sealed under `messageKey`, unpadded. This is the
 * server's half of a report: it holds that one key and never the epoch's.
 */
export function openWithMessageKey(
  fields: MessageFields & {
    messageKey: Uint8Array
    nonce: Uint8Array
    ciphertext: Uint8Array
  }
): Uint8Array {
  return call('openWithMessageKey', [
    ...fieldArgs(fields),
    fields.messageKey,
    fields.nonce,
    fields.ciphertext
  ])[0]
}

/** Checks the signature, then opens. Either failing throws. */
export function openMessage(
  fields: MessageFields &
    SealedMessage & { epochKey: Uint8Array; senderIdentityKey: Uint8Array }
): Uint8Array {
  if (!verifyMessage(fields)) throw new Error('Message signature is not valid')
  return openWithMessageKey({
    ...fields,
    messageKey: messageKey(
      fields.epochKey,
      fields.conversationId,
      fields.messageId
    )
  })
}
