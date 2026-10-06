import { join, lp, u64, utf8 } from './bytes'
import { call } from './core'
import { num } from './coreCall'
import { sign, verify } from './keys'

/**
 * The two key chains, which are why a later key opens everything before it,
 * on the chat crypto core.
 *
 * - **Epochs.** Epoch n's record carries `previous_key_box`: epoch n−1's key,
 *   sealed with XChaCha20-Poly1305 under `HKDF-SHA256(epoch n key,
 *   info = "ts-chat/v1/prev-epoch")`, AAD `lp(conversationId) ‖ u64(n)`. The
 *   creator's identity signs `lp(conversationId) ‖ u64(n) ‖
 *   SHA-256(previous_key_box)`.
 * - **Per-user keys.** PUK generation n carries `previous_keys_box`: every
 *   older private key, each `u64(generation) ‖ lp(privateKey)`, oldest first,
 *   sealed under `HKDF-SHA256(generation n private key, info =
 *   "ts-chat/v1/prev-puk")`, AAD `u64(userId) ‖ lp(identityId) ‖ u64(n)`. The
 *   identity signs `u64(userId) ‖ u64(generation) ‖ lp(publicKey)`.
 *
 * A box is `nonce ‖ ciphertext`, the nonce 24 random bytes. Neither HKDF has
 * a salt.
 */

const NONCE = 24
const TAG = 16
const EMPTY = new Uint8Array(0)

/** Epoch n's `previous_key_box`: epoch n−1's key under epoch n's. */
export function sealPreviousEpochKey(fields: {
  conversationId: string
  epoch: number
  epochKey: Uint8Array
  previousEpochKey: Uint8Array
  nonce?: Uint8Array
}): Uint8Array {
  return call('sealPreviousEpochKey', [
    utf8(fields.conversationId),
    num(fields.epoch),
    fields.epochKey,
    fields.previousEpochKey,
    fields.nonce ?? EMPTY
  ])[0]
}

/** Epoch n−1's key, from epoch n's record and key. */
export function openPreviousEpochKey(fields: {
  conversationId: string
  epoch: number
  epochKey: Uint8Array
  previousKeyBox: Uint8Array
}): Uint8Array {
  if (fields.previousKeyBox.length < NONCE + TAG) {
    throw new TypeError('Box is too short')
  }
  return call('openPreviousEpochKey', [
    utf8(fields.conversationId),
    num(fields.epoch),
    fields.epochKey,
    fields.previousKeyBox
  ])[0]
}

/**
 * What an epoch's creator signs. An epoch with no `previous_key_box` (the
 * first, or a chain break) signs the SHA-256 of no bytes in its place.
 */
export function epochSignedBytes(fields: {
  conversationId: string
  epoch: number
  previousKeyBox: Uint8Array | null
}): Uint8Array {
  return call('epochSignedBytes', [
    utf8(fields.conversationId),
    num(fields.epoch),
    fields.previousKeyBox ?? EMPTY
  ])[0]
}

export function signEpoch(
  fields: Parameters<typeof epochSignedBytes>[0],
  identitySecretKey: Uint8Array
): Uint8Array {
  return sign(epochSignedBytes(fields), identitySecretKey)
}

export function verifyEpoch(
  fields: Parameters<typeof epochSignedBytes>[0],
  signature: Uint8Array,
  identityPublicKey: Uint8Array
): boolean {
  return verify(signature, epochSignedBytes(fields), identityPublicKey)
}

/** One older PUK generation's private key. */
export interface OlderPuk {
  generation: number
  privateKey: Uint8Array
}

/** Generation n's `previous_keys_box`: every older private key, oldest first. */
export function sealPreviousPukKeys(fields: {
  userId: number
  identityId: string
  generation: number
  privateKey: Uint8Array
  older: OlderPuk[]
  nonce?: Uint8Array
}): Uint8Array {
  const sorted = [...fields.older].sort((a, b) => a.generation - b.generation)
  const plaintext = join(
    ...sorted.flatMap(key => [u64(key.generation), lp(key.privateKey)])
  )
  return call('sealPreviousPukKeys', [
    num(fields.userId),
    utf8(fields.identityId),
    num(fields.generation),
    fields.privateKey,
    plaintext,
    fields.nonce ?? EMPTY
  ])[0]
}

/** The older private keys a generation carries, oldest first. */
export function openPreviousPukKeys(fields: {
  userId: number
  identityId: string
  generation: number
  privateKey: Uint8Array
  previousKeysBox: Uint8Array
}): OlderPuk[] {
  if (fields.previousKeysBox.length < NONCE + TAG) {
    throw new TypeError('Box is too short')
  }
  const plaintext = call('openPreviousPukKeys', [
    num(fields.userId),
    utf8(fields.identityId),
    num(fields.generation),
    fields.privateKey,
    fields.previousKeysBox
  ])[0]
  const keys: OlderPuk[] = []
  let at = 0
  while (at < plaintext.length) {
    if (at + 12 > plaintext.length)
      throw new TypeError('Older keys are cut short')
    let generation = 0
    for (let i = 0; i < 8; i++)
      generation = generation * 256 + plaintext[at + i]
    const length =
      ((plaintext[at + 8] << 24) |
        (plaintext[at + 9] << 16) |
        (plaintext[at + 10] << 8) |
        plaintext[at + 11]) >>>
      0
    const start = at + 12
    if (start + length > plaintext.length) {
      throw new TypeError('Older keys are cut short')
    }
    keys.push({
      generation,
      privateKey: plaintext.slice(start, start + length)
    })
    at = start + length
  }
  return keys
}

/** What the identity signs for a PUK generation. */
export function pukSignedBytes(fields: {
  userId: number
  generation: number
  publicKey: Uint8Array
}): Uint8Array {
  return join(u64(fields.userId), u64(fields.generation), lp(fields.publicKey))
}

export function signPuk(
  fields: Parameters<typeof pukSignedBytes>[0],
  identitySecretKey: Uint8Array
): Uint8Array {
  return sign(pukSignedBytes(fields), identitySecretKey)
}

export function verifyPuk(
  fields: Parameters<typeof pukSignedBytes>[0],
  signature: Uint8Array,
  identityPublicKey: Uint8Array
): boolean {
  return verify(signature, pukSignedBytes(fields), identityPublicKey)
}
