import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo, userIdOfValue } from '../common/userId'
import { asIdentityCompatibility } from './chat2Fixture.e2e'

describe('identity compatibility driver descriptor', () => {
  const old = userIdOfGumbo(42)
  const full = userIdOfValue((1n << 127n) + 7n)
  const baseline = {
    actor: 'legacy',
    deviceId: 'cdv_legacy',
    identityId: 'cid_legacy',
    identityPublicKey: 'synthetic public key',
    pukGeneration: 2,
    pukPublicKey: 'synthetic public key',
    safetyNumber: '0'.repeat(60),
    text: { id: 'msg_text', seq: 4, body: 'Original text', authorId: old },
    reply: { id: 'msg_reply', seq: 5, body: 'Original reply', authorId: full },
    file: { id: 'msg_file', seq: 6, body: 'Original file', authorId: old },
    textMentions: [old, full],
    replyMentions: [old]
  }
  it('retains exact canonical IDs while message sequences and key generations remain numbers', () => {
    const input = { legacy: { ios: baseline }, fullWidthActors: ['full'] }
    expect(asIdentityCompatibility(input)).deep.equals(input)
  })
  it('rejects stale numeric or malformed account fields instead of coercing descriptor values', () => {
    for (const invalid of [42, '42', 'usr_bad', 0, null]) {
      expect(() =>
        asIdentityCompatibility({
          legacy: {
            ios: { ...baseline, text: { ...baseline.text, authorId: invalid } }
          },
          fullWidthActors: ['full']
        })
      ).throws()
      expect(() =>
        asIdentityCompatibility({
          legacy: { ios: { ...baseline, textMentions: [invalid] } },
          fullWidthActors: ['full']
        })
      ).throws()
    }
  })
})
