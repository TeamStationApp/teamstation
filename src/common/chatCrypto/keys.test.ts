import { x25519 } from '@noble/curves/ed25519.js'
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

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

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

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
    expect(hex(x25519.getSharedSecret(a.secretKey, b.publicKey))).equals(
      hex(x25519.getSharedSecret(b.secretKey, a.publicKey))
    )
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

  it('throws, rather than guessing, when there is no getRandomValues', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      configurable: true
    })
    expect(() => randomBytes(4)).throws('react-native-get-random-values')
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true
    })
    expect(() => randomBytes(4)).throws('getRandomValues')
  })
})
