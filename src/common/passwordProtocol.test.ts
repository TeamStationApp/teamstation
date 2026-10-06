import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  testPasswordCosts,
  testPasswordParameters
} from '../test/passwordFixtures'
import {
  asArgonParameters,
  asClientHash,
  asNewPasswordParameters,
  asPasswordUpdate,
  bytesHex,
  checkNewPassword,
  clientParameters,
  hexBytes,
  newPasswordRequirements,
  passwordBytes,
  rejectRawPassword
} from './passwordProtocol'

describe('Argon2 password protocol', () => {
  it('preserves UTF-8 bytes including supplementary and malformed characters', () => {
    for (const value of [
      'ascii',
      'é',
      '漢字',
      '😀',
      '\ud800',
      '\udfff',
      'a\ud800z'
    ])
      expect(bytesHex(passwordBytes(value))).equals(
        Buffer.from(value).toString('hex')
      )
    expect(hexBytes('')).length(0)
    expect(bytesHex(hexBytes('00aaff'))).equals('00aaff')
  })
  it('validates complete bounded parameters before allocating work', () => {
    expect(
      clientParameters(testPasswordParameters.salt, testPasswordCosts)
    ).deep.equals(testPasswordParameters)
    expect(clientParameters(testPasswordParameters.salt).memoryKiB).equals(
      32768
    )
    for (const patch of [
      { algorithm: 'argon2i' },
      { version: 16 },
      { hashLength: 64 },
      { memoryKiB: 19455 },
      { memoryKiB: 65537 },
      { memoryKiB: 19457 },
      { memoryKiB: Infinity },
      { parallelism: 0 },
      { parallelism: 5 },
      { parallelism: 1.1 },
      { iterations: 1 },
      { iterations: 1025 },
      { iterations: 2.1 },
      { salt: '00' },
      { salt: 'AB'.repeat(16) }
    ])
      expect(() =>
        asArgonParameters({ ...testPasswordParameters, ...patch })
      ).throws()
    for (const value of [undefined, null, 1, 'text'])
      expect(() => asArgonParameters(value)).throws()
    expect(
      asArgonParameters({ ...testPasswordParameters, iterations: 4096 }, true)
        .iterations
    ).equals(4096)
    expect(() =>
      asArgonParameters({ ...testPasswordParameters, iterations: 4097 }, true)
    ).throws()
    expect(() => asClientHash('x'.repeat(64))).throws()
    expect(asClientHash('ab'.repeat(32))).length(64)
  })
  it('enforces the new-write floor while preserving readable old credentials', () => {
    const old = {
      ...testPasswordParameters,
      memoryKiB: 65536,
      iterations: 16,
      parallelism: 1
    }
    expect(asArgonParameters(old)).deep.equals(old)
    expect(() => asNewPasswordParameters(old)).throws()
    for (const patch of [
      { memoryKiB: 19456 },
      { iterations: 5 },
      { parallelism: 2 }
    ])
      expect(() =>
        asNewPasswordParameters({ ...testPasswordParameters, ...patch })
      ).throws()
    expect(asNewPasswordParameters(testPasswordParameters)).deep.equals(
      testPasswordParameters
    )
  })
  it('requires eight Unicode characters and composition unless length exceeds sixteen', () => {
    for (const password of [
      'Abcdef1',
      'abcdefgh',
      'ABCDEFG1',
      'abcdefg1',
      'Abcdefgh',
      'a'.repeat(16),
      '😀'.repeat(7)
    ])
      expect(newPasswordRequirements(password).valid, password).equals(false)
    for (const password of [
      'Abcdefg1',
      'a'.repeat(17),
      'a'.repeat(1024),
      'Éé١abcde',
      '😀'.repeat(17)
    ]) {
      expect(newPasswordRequirements(password).valid, password).equals(true)
      expect(() => {
        checkNewPassword(password)
      }).not.throws()
    }
    expect(newPasswordRequirements('😀'.repeat(8)).length).equals(true)
    expect(newPasswordRequirements('😀'.repeat(8)).long).equals(false)
    expect(newPasswordRequirements('Éé١abcde')).includes({
      uppercase: true,
      lowercase: true,
      number: true
    })
    expect(newPasswordRequirements('é'.repeat(512)).valid).equals(true)
    expect(newPasswordRequirements('é'.repeat(513)).tooLong).equals(true)
    expect(newPasswordRequirements('a'.repeat(1025)).valid).equals(false)
  })
  it('rejects raw password wire fields and enforces local password policy', () => {
    for (const raw of [{ password: 'raw' }, { currentPassword: 'raw' }])
      expect(() =>
        asPasswordUpdate({
          ...raw,
          clientHash: 'ab'.repeat(32),
          clientParameters: testPasswordParameters
        })
      ).throws()
    for (const raw of [null, undefined, 'string', {}])
      expect(() => {
        rejectRawPassword(raw)
      }).not.throws()
    expect(
      asPasswordUpdate({
        clientHash: 'ab'.repeat(32),
        clientParameters: testPasswordParameters,
        reset: { requestId: 'id', code: 'code' }
      }).reset?.requestId
    ).equals('id')
    for (const password of ['short', 'a'.repeat(1025), '😀'.repeat(257)])
      expect(() => {
        checkNewPassword(password)
      }).throws()
    expect(() => {
      checkNewPassword('é'.repeat(100))
    }).not.throws()
  })
})
