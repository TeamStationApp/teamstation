import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { hex, oracle, seed } from '../../test/chatCryptoOracle'
import {
  boxPublicKey,
  newBoxKeyPair,
  newDeviceKeys,
  newEpochKey,
  newIdentityKey,
  newPukKey,
  newSigningKeyPair,
  sign,
  signingPublicKey,
  verify
} from './keys'
import { randomBytes } from './random'

describe('chatCrypto keys', () => {
  it('device keys are an X25519 pair and an Ed25519 pair, all fresh', () => {
    const one = newDeviceKeys()
    const two = newDeviceKeys()
    expect(one.box.secretKey.length).equals(32)
    expect(hex(one.box.publicKey)).equals(hex(boxPublicKey(one.box.secretKey)))
    expect(hex(one.sign.publicKey)).equals(
      hex(signingPublicKey(one.sign.secretKey))
    )
    expect(hex(one.box.secretKey)).not.equals(hex(two.box.secretKey))
    expect(hex(one.sign.secretKey)).not.equals(hex(two.sign.secretKey))
  })

  it('two box pairs agree on a shared secret', () => {
    const a = newBoxKeyPair()
    const b = newPukKey()
    expect(hex(oracle.x25519(a.secretKey, b.publicKey))).equals(
      hex(oracle.x25519(b.secretKey, a.publicKey))
    )
  })

  it('public keys and signatures are the ones Node makes and accepts', () => {
    const secret = seed('identity')
    expect(hex(boxPublicKey(secret))).equals(
      hex(oracle.x25519PublicKey(secret))
    )
    expect(hex(signingPublicKey(secret))).equals(
      hex(oracle.ed25519PublicKey(secret))
    )
    const message = Uint8Array.of(1, 2, 3)
    const signature = sign(message, secret)
    expect(hex(signature)).equals(hex(oracle.ed25519Sign(message, secret)))
    expect(
      oracle.ed25519Verify(signature, message, signingPublicKey(secret))
    ).equals(true)
    expect(
      verify(
        oracle.ed25519Sign(message, secret),
        message,
        signingPublicKey(secret)
      )
    ).equals(true)
  })

  it('signs and verifies, and refuses another key, message or garbage', () => {
    const identity = newIdentityKey()
    const message = Uint8Array.of(1, 2, 3)
    const signature = sign(message, identity.secretKey)
    expect(signature.length).equals(64)
    expect(verify(signature, message, identity.publicKey)).equals(true)
    expect(verify(signature, Uint8Array.of(1, 2), identity.publicKey)).equals(
      false
    )
    expect(verify(signature, message, newSigningKeyPair().publicKey)).equals(
      false
    )
    expect(verify(new Uint8Array(2), message, identity.publicKey)).equals(false)
    expect(verify(signature, message, new Uint8Array(3))).equals(false)
  })

  it('an epoch key is 32 fresh bytes', () => {
    expect(newEpochKey().length).equals(32)
    expect(hex(newEpochKey())).not.equals(hex(newEpochKey()))
  })
})

describe('chatCrypto random', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  afterEach(() => {
    if (saved != null) Object.defineProperty(globalThis, 'crypto', saved)
  })

  it('fills more than one Web Crypto call’s worth', () => {
    const bytes = randomBytes(65536 * 2 + 5)
    expect(bytes.length).equals(65536 * 2 + 5)
    expect(bytes.subarray(65536 * 2).some(byte => byte !== 0)).equals(true)
    expect(randomBytes(0).length).equals(0)
  })

  it('comes from the core, with or without crypto.getRandomValues', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true
    })
    expect(randomBytes(32).length).equals(32)
    expect(() => randomBytes(-1)).throws(RangeError)
    expect(() => randomBytes(0.5)).throws(RangeError)
  })
})
