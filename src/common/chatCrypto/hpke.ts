import { join, lp, u64, utf8 } from './bytes'
import { call } from './core'
import type { KeyPair } from './keys'

export type { KeyPair } from './keys'

/**
 * HPKE (RFC 9180) in base mode, for one suite only:
 * `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, `ChaCha20Poly1305`
 * (KEM 0x0020, KDF 0x0001, AEAD 0x0003), on the chat crypto core.
 *
 * Chat wraps a key to somebody's public key with it: a new device's identity
 * key (`link`), a per-user key generation to a device (`puk`), and an epoch
 * key to a member's PUK (`epoch` when the epoch is made, `grant` when it is
 * handed on later). A box is `enc ‖ ciphertext`: the 32-byte ephemeral public
 * key, then the AEAD output with its 16-byte tag. Each box is one seal under
 * a fresh context, so no context is ever kept open.
 *
 * The RFC's Appendix A.2.1 vectors check the core (`vectors.ts`, and the
 * crate's own tests).
 */

const N_ENC = 32
const TAG = 16
const EMPTY = new Uint8Array(0)

/** RFC 9180 `DeriveKeyPair` for X25519: the same `ikm` always gives the same pair. */
export function deriveKeyPair(ikm: Uint8Array): KeyPair {
  const [secretKey, publicKey] = call('deriveKeyPair', [ikm])
  return { secretKey, publicKey }
}

/** What a box is for. Each has its own `info` and its own AAD. */
export type HpkePurpose = 'link' | 'puk' | 'epoch' | 'grant'

/** `"ts-chat/v1/" + purpose`, the `info` the core gives each purpose. */
export function hpkeInfo(purpose: HpkePurpose): Uint8Array {
  return utf8(`ts-chat/v1/${purpose}`)
}

/** `link`: `lp(linkId) ‖ lp(newDeviceId)`. */
export function linkAad(fields: {
  linkId: string
  newDeviceId: string
}): Uint8Array {
  return join(lp(fields.linkId), lp(fields.newDeviceId))
}

/** `puk`: `u64(userId) ‖ lp(identityId) ‖ u64(generation) ‖ lp(deviceId)`. */
export function pukAad(fields: {
  userId: number
  identityId: string
  generation: number
  deviceId: string
}): Uint8Array {
  return join(
    u64(fields.userId),
    lp(fields.identityId),
    u64(fields.generation),
    lp(fields.deviceId)
  )
}

/**
 * `epoch` and `grant`: `lp(conversationId) ‖ u64(epoch) ‖
 * u64(recipientUserId) ‖ lp(identityId) ‖ u64(generation)`, where the
 * identity and generation are the recipient's PUK the key is wrapped to.
 */
export function epochAad(fields: {
  conversationId: string
  epoch: number
  recipientUserId: number
  identityId: string
  generation: number
}): Uint8Array {
  return join(
    lp(fields.conversationId),
    u64(fields.epoch),
    u64(fields.recipientUserId),
    lp(fields.identityId),
    u64(fields.generation)
  )
}

/**
 * Wraps `plaintext` to `recipientPublicKey`: one single-shot seal,
 * `enc ‖ ciphertext`. The ephemeral key is random unless `ephemeralIkm` is
 * given, which only tests do, to make a box come out the same every time. A
 * small-order public key (an all-zero shared secret, RFC 9180 §7.1.4) throws.
 */
export function hpkeSeal(
  purpose: HpkePurpose,
  recipientPublicKey: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  ephemeralIkm?: Uint8Array
): Uint8Array {
  return call('hpkeSeal', [
    utf8(purpose),
    recipientPublicKey,
    aad,
    plaintext,
    ephemeralIkm ?? EMPTY
  ])[0]
}

/** Opens a box from `hpkeSeal`. A wrong key, purpose, AAD or a changed byte throws. */
export function hpkeOpen(
  purpose: HpkePurpose,
  recipientSecretKey: Uint8Array,
  aad: Uint8Array,
  box: Uint8Array
): Uint8Array {
  if (box.length < N_ENC + TAG) throw new TypeError('HPKE box is too short')
  return call('hpkeOpen', [utf8(purpose), recipientSecretKey, aad, box])[0]
}
