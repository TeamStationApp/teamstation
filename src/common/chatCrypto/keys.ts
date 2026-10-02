import type { KeyPair } from './hpke'
import { primitives } from './primitives'
import { randomBytes } from './random'

export type { KeyPair } from './hpke'

/**
 * The keys of encrypted chat, made here and nowhere else.
 *
 * | Key | Kind |
 * | --- | --- |
 * | Device keys | an X25519 pair (link boxes come to it) and an Ed25519 pair (proves the device on resume) |
 * | Identity key | Ed25519, shared by a user's linked devices; signs PUKs, epochs and messages |
 * | Per-user key (PUK) | X25519, one per generation; epoch keys are wrapped to it |
 * | Epoch key | 32 random bytes per conversation and epoch; messages are sealed under it |
 *
 * A secret key is always 32 bytes: an X25519 secret or an Ed25519 seed.
 */

/** An X25519 pair, for receiving HPKE boxes. */
export function newBoxKeyPair(): KeyPair {
  const secretKey = randomBytes(32)
  return { secretKey, publicKey: primitives.x25519PublicKey(secretKey) }
}

/** An Ed25519 pair, for signing. */
export function newSigningKeyPair(): KeyPair {
  const secretKey = randomBytes(32)
  return { secretKey, publicKey: primitives.ed25519PublicKey(secretKey) }
}

export interface DeviceKeys {
  box: KeyPair
  sign: KeyPair
}

/** One device's two pairs. They never leave it. */
export function newDeviceKeys(): DeviceKeys {
  return { box: newBoxKeyPair(), sign: newSigningKeyPair() }
}

/** A user's identity key. */
export const newIdentityKey = newSigningKeyPair

/** A user's per-user key, one generation of it. */
export const newPukKey = newBoxKeyPair

/** A conversation's key for one epoch. */
export function newEpochKey(): Uint8Array {
  return randomBytes(32)
}

/** The X25519 public key of a secret key. */
export function boxPublicKey(secretKey: Uint8Array): Uint8Array {
  return primitives.x25519PublicKey(secretKey)
}

/** The Ed25519 public key of a secret key. */
export function signingPublicKey(secretKey: Uint8Array): Uint8Array {
  return primitives.ed25519PublicKey(secretKey)
}

/** An Ed25519 signature of `message`. */
export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return primitives.ed25519Sign(message, secretKey)
}

/** Whether `signature` is `publicKey`'s over `message`. Malformed input is simply false. */
export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return primitives.ed25519Verify(signature, message, publicKey)
}
