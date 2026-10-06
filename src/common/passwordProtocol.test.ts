import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  testPasswordCosts,
  testPasswordParameters
} from '../test/passwordFixtures'
import {
  asArgonParameters,
  asClientHash,
  asPasswordUpdate,
  bytesHex,
  checkNewPassword,
  clientParameters,
  hexBytes,
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
      65536
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
      { iterations: 33 },
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
      asArgonParameters({ ...testPasswordParameters, iterations: 128 }, true)
        .iterations
    ).equals(128)
    expect(() =>
      asArgonParameters({ ...testPasswordParameters, iterations: 129 }, true)
    ).throws()
    expect(() => asClientHash('x'.repeat(64))).throws()
    expect(asClientHash('ab'.repeat(32))).length(64)
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
