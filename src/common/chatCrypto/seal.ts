import { join, lp, pad, u64, unpad, utf8 } from './bytes'
import { hkdf } from './kdf'
import { sign, verify } from './keys'
import { primitives } from './primitives'
import { randomBytes } from './random'

/**
 * One message, sealed and signed.
 *
 * - The message key is `HKDF-SHA256(epochKey, salt = conversationId,
 *   info = "ts-chat/v1/msg" ‖ messageId)` (both strings as UTF-8), so each
 *   message has its own key, and a reporter can hand the server that one key
 *   without the epoch's.
 * - The cipher is XChaCha20-Poly1305 with a random 24-byte nonce, over the
 *   content padded to its bucket (`bytes.ts`), with AAD
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

const MSG_INFO = utf8('ts-chat/v1/msg')

export function messageAad(fields: MessageFields): Uint8Array {
  return join(
    lp(fields.conversationId),
    u64(fields.epoch),
    lp(fields.messageId),
    u64(fields.senderUserId),
    lp(fields.kind)
  )
}

/** This one message's key, from the epoch key. */
export function messageKey(
  epochKey: Uint8Array,
  conversationId: string,
  messageId: string
): Uint8Array {
  return hkdf(
    epochKey,
    utf8(conversationId),
    join(MSG_INFO, utf8(messageId)),
    32
  )
}

/** What the identity key signs: `SHA-256(aad ‖ nonce ‖ ciphertext)`. */
export function signedDigest(
  aad: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  return primitives.sha256(join(aad, nonce, ciphertext))
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
  const nonce = fields.nonce ?? randomBytes(24)
  const aad = messageAad(fields)
  const key = messageKey(
    fields.epochKey,
    fields.conversationId,
    fields.messageId
  )
  const ciphertext = primitives.xchacha20Poly1305Seal(
    key,
    nonce,
    aad,
    pad(fields.plaintext)
  )
  return {
    nonce,
    ciphertext,
    signature: sign(
      signedDigest(aad, nonce, ciphertext),
      fields.identitySecretKey
    )
  }
}

/** Whether the signature is the sender identity's over this envelope. */
export function verifyMessage(
  fields: MessageFields & SealedMessage & { senderIdentityKey: Uint8Array }
): boolean {
  return verify(
    fields.signature,
    signedDigest(messageAad(fields), fields.nonce, fields.ciphertext),
    fields.senderIdentityKey
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
  return unpad(
    primitives.xchacha20Poly1305Open(
      fields.messageKey,
      fields.nonce,
      messageAad(fields),
      fields.ciphertext
    )
  )
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
