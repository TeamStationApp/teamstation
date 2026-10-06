import { expect } from 'chai'
import { describe, it } from 'mocha'

import { join, lp } from './bytes'
import { newSigningKeyPair, verify } from './keys'
import { resumeSignedBytes, signResume, verifyResume } from './resume'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

describe('chatCrypto resume', () => {
  const nonce = new Uint8Array(32).fill(9)
  const fields = { nonce, deviceId: 'cdv_1', sessionId: 'ses_1' }

  it('signs lp(nonce) ‖ lp(deviceId) ‖ lp(sessionId)', () => {
    expect(hex(resumeSignedBytes(fields))).equals(
      hex(join(lp(nonce), lp('cdv_1'), lp('ses_1')))
    )
    const device = newSigningKeyPair()
    const signature = signResume(fields, device.secretKey)
    expect(
      verify(signature, resumeSignedBytes(fields), device.publicKey)
    ).equals(true)
    expect(verifyResume(fields, signature, device.publicKey)).equals(true)
  })

  it('fails for another nonce, device, session or key', () => {
    const device = newSigningKeyPair()
    const signature = signResume(fields, device.secretKey)
    expect(
      verifyResume(
        { ...fields, nonce: new Uint8Array(32) },
        signature,
        device.publicKey
      )
    ).equals(false)
    expect(
      verifyResume(
        { ...fields, deviceId: 'cdv_2' },
        signature,
        device.publicKey
      )
    ).equals(false)
    expect(
      verifyResume(
        { ...fields, sessionId: 'ses_2' },
        signature,
        device.publicKey
      )
    ).equals(false)
    expect(
      verifyResume(fields, signature, newSigningKeyPair().publicKey)
    ).equals(false)
    expect(verifyResume(fields, new Uint8Array(64), device.publicKey)).equals(
      false
    )
  })
})
