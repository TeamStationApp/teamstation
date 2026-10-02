import { join, lp, u64, utf8 } from './bytes'
import { hkdf } from './kdf'
import { sign, verify } from './keys'
import { primitives } from './primitives'
import { randomBytes } from './random'

/**
 * The two key chains, which are why a later key opens everything before it.
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
const EMPTY = new Uint8Array(0)
const PREV_EPOCH = utf8('ts-chat/v1/prev-epoch')
const PREV_PUK = utf8('ts-chat/v1/prev-puk')

function sealBox(
  key: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  nonce = randomBytes(NONCE)
): Uint8Array {
  return join(
    nonce,
    primitives.xchacha20Poly1305Seal(key, nonce, aad, plaintext)
  )
}

function openBox(
  key: Uint8Array,
  aad: Uint8Array,
  box: Uint8Array
): Uint8Array {
  if (box.length < NONCE + 16) throw new TypeError('Box is too short')
  return primitives.xchacha20Poly1305Open(
    key,
    box.subarray(0, NONCE),
    aad,
    box.subarray(NONCE)
  )
}

function epochChainKey(epochKey: Uint8Array): Uint8Array {
  return hkdf(epochKey, EMPTY, PREV_EPOCH, 32)
}

function epochChainAad(conversationId: string, epoch: number): Uint8Array {
  return join(lp(conversationId), u64(epoch))
}

/** Epoch n's `previous_key_box`: epoch n−1's key under epoch n's. */
export function sealPreviousEpochKey(fields: {
  conversationId: string
  epoch: number
  epochKey: Uint8Array
  previousEpochKey: Uint8Array
  nonce?: Uint8Array
}): Uint8Array {
  return sealBox(
    epochChainKey(fields.epochKey),
    epochChainAad(fields.conversationId, fields.epoch),
    fields.previousEpochKey,
    fields.nonce
  )
}

/** Epoch n−1's key, from epoch n's record and key. */
export function openPreviousEpochKey(fields: {
  conversationId: string
  epoch: number
  epochKey: Uint8Array
  previousKeyBox: Uint8Array
}): Uint8Array {
  return openBox(
    epochChainKey(fields.epochKey),
    epochChainAad(fields.conversationId, fields.epoch),
    fields.previousKeyBox
  )
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
  return join(
    lp(fields.conversationId),
    u64(fields.epoch),
    primitives.sha256(fields.previousKeyBox ?? EMPTY)
  )
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

function pukChainKey(privateKey: Uint8Array): Uint8Array {
  return hkdf(privateKey, EMPTY, PREV_PUK, 32)
}

function pukChainAad(
  userId: number,
  identityId: string,
  generation: number
): Uint8Array {
  return join(u64(userId), lp(identityId), u64(generation))
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
  return sealBox(
    pukChainKey(fields.privateKey),
    pukChainAad(fields.userId, fields.identityId, fields.generation),
    plaintext,
    fields.nonce
  )
}

/** The older private keys a generation carries, oldest first. */
export function openPreviousPukKeys(fields: {
  userId: number
  identityId: string
  generation: number
  privateKey: Uint8Array
  previousKeysBox: Uint8Array
}): OlderPuk[] {
  const plaintext = openBox(
    pukChainKey(fields.privateKey),
    pukChainAad(fields.userId, fields.identityId, fields.generation),
    fields.previousKeysBox
  )
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
