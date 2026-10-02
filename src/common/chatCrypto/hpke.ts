import { join, lp, u64, utf8 } from './bytes'
import { primitives } from './primitives'
import { randomBytes } from './random'

/**
 * HPKE (RFC 9180) in base mode, for one suite only:
 * `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, `ChaCha20Poly1305`
 * (KEM 0x0020, KDF 0x0001, AEAD 0x0003) on the platform's `primitives`.
 *
 * Chat wraps a key to somebody's public key with it: a new device's identity
 * key (`link`), a per-user key generation to a device (`puk`), and an epoch
 * key to a member's PUK (`epoch` when the epoch is made, `grant` when it is
 * handed on later). A box is `enc ‖ ciphertext`: the 32-byte ephemeral public
 * key, then the AEAD output with its 16-byte tag.
 *
 * The RFC's Appendix A.2 vectors check this file (`hpke.test.ts`).
 */

const KEM_ID = 0x0020
const KDF_ID = 0x0001
const AEAD_ID = 0x0003
const N_SECRET = 32
const N_ENC = 32
const N_K = 32
const N_N = 12
const N_H = 32

const i2osp2 = (n: number): Uint8Array => Uint8Array.of(n >> 8, n & 0xff)
const ascii = utf8
const HPKE_V1 = ascii('HPKE-v1')
const KEM_SUITE = join(ascii('KEM'), i2osp2(KEM_ID))
const HPKE_SUITE = join(
  ascii('HPKE'),
  i2osp2(KEM_ID),
  i2osp2(KDF_ID),
  i2osp2(AEAD_ID)
)
const EMPTY = new Uint8Array(0)

function labeledExtract(
  suite: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array
): Uint8Array {
  return primitives.hkdfExtract(salt, join(HPKE_V1, suite, ascii(label), ikm))
}

function labeledExpand(
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number
): Uint8Array {
  return primitives.hkdfExpand(
    prk,
    join(i2osp2(length), HPKE_V1, suite, ascii(label), info),
    length
  )
}

export interface KeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

/** RFC 9180 `DeriveKeyPair` for X25519: the same `ikm` always gives the same pair. */
export function deriveKeyPair(ikm: Uint8Array): KeyPair {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'dkp_prk', ikm)
  const secretKey = labeledExpand(KEM_SUITE, prk, 'sk', EMPTY, 32)
  return { secretKey, publicKey: primitives.x25519PublicKey(secretKey) }
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // Both twins refuse an all-zero result (a small-order public key), which is the
  // check RFC 9180 §7.1.4 requires of X25519.
  return primitives.x25519(secretKey, publicKey)
}

function sharedSecret(
  shared: Uint8Array,
  enc: Uint8Array,
  recipientPublicKey: Uint8Array
): Uint8Array {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', shared)
  return labeledExpand(
    KEM_SUITE,
    prk,
    'shared_secret',
    join(enc, recipientPublicKey),
    N_SECRET
  )
}

/**
 * A base-mode context, sender's or recipient's: the key, the base nonce and
 * the exporter secret, and a sequence number that moves on with every seal or
 * open, as the RFC's `ContextS` and `ContextR` do.
 */
export class HpkeContext {
  readonly key: Uint8Array
  readonly baseNonce: Uint8Array
  readonly exporterSecret: Uint8Array
  private seq = 0

  constructor(shared: Uint8Array, info: Uint8Array) {
    const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY)
    const infoHash = labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info)
    const context = join(Uint8Array.of(0), pskIdHash, infoHash)
    const secret = labeledExtract(HPKE_SUITE, shared, 'secret', EMPTY)
    this.key = labeledExpand(HPKE_SUITE, secret, 'key', context, N_K)
    this.baseNonce = labeledExpand(
      HPKE_SUITE,
      secret,
      'base_nonce',
      context,
      N_N
    )
    this.exporterSecret = labeledExpand(HPKE_SUITE, secret, 'exp', context, N_H)
  }

  /** The nonce for the current sequence number, then the number moves on. */
  private nextNonce(): Uint8Array {
    const seq = u64(this.seq)
    const nonce = this.baseNonce.slice()
    for (let i = 0; i < 8; i++) nonce[N_N - 8 + i] ^= seq[i]
    this.seq++
    return nonce
  }

  /** Jumps to a sequence number, for the RFC's vectors that skip some. */
  setSequence(seq: number): void {
    this.seq = seq
  }

  seal(aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return primitives.chacha20Poly1305Seal(
      this.key,
      this.nextNonce(),
      aad,
      plaintext
    )
  }

  open(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    return primitives.chacha20Poly1305Open(
      this.key,
      this.nextNonce(),
      aad,
      ciphertext
    )
  }

  export(exporterContext: Uint8Array, length: number): Uint8Array {
    return labeledExpand(
      HPKE_SUITE,
      this.exporterSecret,
      'sec',
      exporterContext,
      length
    )
  }
}

/**
 * RFC 9180 `SetupBaseS`. The ephemeral key is random unless `ephemeralIkm` is
 * given, which only tests do, to make a box come out the same every time.
 */
export function setupBaseSender(
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
  ephemeralIkm?: Uint8Array
): { enc: Uint8Array; context: HpkeContext } {
  const ephemeral =
    ephemeralIkm == null
      ? (() => {
          const secretKey = randomBytes(32)
          return {
            secretKey,
            publicKey: primitives.x25519PublicKey(secretKey)
          }
        })()
      : deriveKeyPair(ephemeralIkm)
  const enc = ephemeral.publicKey
  const shared = sharedSecret(
    dh(ephemeral.secretKey, recipientPublicKey),
    enc,
    recipientPublicKey
  )
  return { enc, context: new HpkeContext(shared, info) }
}

/** RFC 9180 `SetupBaseR`. */
export function setupBaseRecipient(
  enc: Uint8Array,
  recipientSecretKey: Uint8Array,
  info: Uint8Array
): HpkeContext {
  if (enc.length !== N_ENC) throw new TypeError('HPKE enc is not 32 bytes')
  const shared = sharedSecret(
    dh(recipientSecretKey, enc),
    enc,
    primitives.x25519PublicKey(recipientSecretKey)
  )
  return new HpkeContext(shared, info)
}

/** What a box is for. Each has its own `info` and its own AAD. */
export type HpkePurpose = 'link' | 'puk' | 'epoch' | 'grant'

/** `"ts-chat/v1/" + purpose`. */
export function hpkeInfo(purpose: HpkePurpose): Uint8Array {
  return ascii(`ts-chat/v1/${purpose}`)
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

/** Wraps `plaintext` to `recipientPublicKey`: one single-shot seal, `enc ‖ ciphertext`. */
export function hpkeSeal(
  purpose: HpkePurpose,
  recipientPublicKey: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  ephemeralIkm?: Uint8Array
): Uint8Array {
  const { enc, context } = setupBaseSender(
    recipientPublicKey,
    hpkeInfo(purpose),
    ephemeralIkm
  )
  return join(enc, context.seal(aad, plaintext))
}

/** Opens a box from `hpkeSeal`. A wrong key, purpose, AAD or a changed byte throws. */
export function hpkeOpen(
  purpose: HpkePurpose,
  recipientSecretKey: Uint8Array,
  aad: Uint8Array,
  box: Uint8Array
): Uint8Array {
  if (box.length < N_ENC + 16) throw new TypeError('HPKE box is too short')
  const context = setupBaseRecipient(
    box.subarray(0, N_ENC),
    recipientSecretKey,
    hpkeInfo(purpose)
  )
  return context.open(aad, box.subarray(N_ENC))
}
