import { createHash } from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { oracle, seed } from '../../test/chatCryptoOracle'
import { userIdOfValue } from '../userId'
import { join, lp, u64, utf8 } from './bytes'
import {
  openPreviousPukKeys,
  pukSignedBytes,
  sealPreviousPukKeys
} from './chain'
import { call } from './core'
import { num } from './coreCall'
import { deriveKeyPair, epochAad, hpkeOpen, hpkeSeal, pukAad } from './hpke'
import { safetyHalf, safetyNumber } from './safetyNumber'
import {
  messageAad,
  messageKey,
  openMessage,
  sealMessage,
  verifyMessage
} from './seal'
import { actorIdentityBytes, compareUserIds, identityBytes } from './userId'

/** Independent test encoding: no application encoder participates in these vectors. */
function encoded(value: bigint): Uint8Array {
  if (value < 1n << 53n) return u64(value)
  const out = Buffer.alloc(17)
  out[0] = 255
  out.writeBigUInt64BE(value >> 64n, 1)
  out.writeBigUInt64BE(value & ((1n << 64n) - 1n), 9)
  return out
}

const values = [
  1n,
  (1n << 53n) - 1n,
  1n << 53n,
  (1n << 64n) - 1n,
  1n << 64n,
  (1n << 127n) + 7n,
  (1n << 128n) - 1n
]

describe('canonical identities at the actual crypto ABI', () => {
  for (const value of values) {
    it(`hashes the complete identity ${value} beside a nullable or mixed actor`, () => {
      const member = encoded(value)
      for (const actor of [u64(0), encoded(7n), encoded((1n << 127n) + 9n)]) {
        const expected = createHash('sha256')
          .update(
            join(
              new Uint8Array(32),
              lp('cnv_identity'),
              u64(1),
              lp('join'),
              member,
              actor,
              lp(''),
              u64(1234)
            )
          )
          .digest()
        const got = call('logRowHash', [
          new Uint8Array(32),
          utf8('cnv_identity'),
          num(1),
          utf8('join'),
          member,
          actor,
          utf8(''),
          num(1234)
        ])[0]
        expect(Buffer.from(got)).deep.equals(expected)
      }
    })
  }

  it('encodes validated canonical accounts with no aliases or precision loss', () => {
    for (const value of values) {
      const id = userIdOfValue(value)
      expect(identityBytes(id)).deep.equals(new Uint8Array(encoded(value)))
      expect(actorIdentityBytes(id)).deep.equals(identityBytes(id))
      expect(compareUserIds(id, id)).equals(0)
    }
    expect(actorIdentityBytes(null)).deep.equals(new Uint8Array(8))
    const low = userIdOfValue(7n)
    const high = userIdOfValue((1n << 127n) + 7n)
    expect(compareUserIds(low, high)).equals(-1)
    expect(compareUserIds(high, low)).equals(1)
    for (const invalid of [
      '',
      '42',
      'usr_1111111111111111111111',
      'usr_zzzzzzzzzzzzzzzzzzzzzz'
    ]) {
      expect(() => identityBytes(invalid)).throws(TypeError)
    }
  })

  for (const value of values) {
    it(`binds complete identity ${value} in every authenticated construction`, () => {
      const id = userIdOfValue(value)
      const other = userIdOfValue(value === 1n ? 2n : 1n)
      const identity = seed('identity')
      const epochKey = seed('epoch key')
      const nonce = seed('nonce').subarray(0, 24)
      const plaintext = utf8('authenticated legacy or full-width author')
      const fields = {
        conversationId: 'cnv_identity',
        epoch: 1,
        messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        senderUserId: id,
        kind: 'post' as const
      }
      const aad = join(
        lp(fields.conversationId),
        u64(1),
        lp(fields.messageId),
        encoded(value),
        lp('post')
      )
      expect(messageAad(fields)).deep.equals(aad)
      const sealed = sealMessage({
        ...fields,
        epochKey,
        plaintext,
        identitySecretKey: identity,
        nonce
      })
      const padded = new Uint8Array(541)
      padded.set(plaintext)
      padded[plaintext.length] = 128
      const key = oracle.hkdf(
        epochKey,
        utf8(fields.conversationId),
        join(utf8('ts-chat/v1/msg'), utf8(fields.messageId)),
        32
      )
      expect(
        messageKey(epochKey, fields.conversationId, fields.messageId)
      ).deep.equals(key)
      expect(sealed.ciphertext).deep.equals(
        oracle.xchacha20Poly1305Seal(key, nonce, aad, padded)
      )
      expect(sealed.signature).deep.equals(
        oracle.ed25519Sign(
          oracle.sha256(join(aad, nonce, sealed.ciphertext)),
          identity
        )
      )
      const senderIdentityKey = oracle.ed25519PublicKey(identity)
      expect(
        openMessage({ ...fields, ...sealed, epochKey, senderIdentityKey })
      ).deep.equals(plaintext)
      expect(
        verifyMessage({
          ...fields,
          ...sealed,
          senderIdentityKey,
          senderUserId: other
        })
      ).equals(false)

      const puk = deriveKeyPair(seed('recipient'))
      const pukFields = {
        userId: id,
        identityId: 'cid_identity',
        generation: 2,
        privateKey: puk.secretKey
      }
      const older = [{ generation: 1, privateKey: seed('older puk') }]
      const previousKeysBox = sealPreviousPukKeys({
        ...pukFields,
        older,
        nonce
      })
      expect(
        openPreviousPukKeys({ ...pukFields, previousKeysBox })
      ).deep.equals(older)
      expect(() =>
        openPreviousPukKeys({ ...pukFields, previousKeysBox, userId: other })
      ).throws()
      expect(
        pukSignedBytes({ userId: id, generation: 2, publicKey: puk.publicKey })
      ).deep.equals(join(encoded(value), u64(2), lp(puk.publicKey)))
      const purposeAads = [
        pukAad({
          userId: id,
          identityId: 'cid_identity',
          generation: 2,
          deviceId: 'cdv_identity'
        }),
        epochAad({
          conversationId: 'cnv_identity',
          epoch: 1,
          recipientUserId: id,
          identityId: 'cid_identity',
          generation: 2
        })
      ]
      expect(purposeAads[0]).deep.equals(
        join(encoded(value), lp('cid_identity'), u64(2), lp('cdv_identity'))
      )
      expect(purposeAads[1]).deep.equals(
        join(
          lp('cnv_identity'),
          u64(1),
          encoded(value),
          lp('cid_identity'),
          u64(2)
        )
      )
      for (const [index, purpose] of (
        ['puk', 'epoch', 'grant'] as const
      ).entries()) {
        const purposeAad = purposeAads[index === 0 ? 0 : 1]
        const box = hpkeSeal(
          purpose,
          puk.publicKey,
          purposeAad,
          epochKey,
          seed('ephemeral')
        )
        expect(hpkeOpen(purpose, puk.secretKey, purposeAad, box)).deep.equals(
          epochKey
        )
        const changed = purposeAad.slice()
        changed[changed.length - 1] ^= 1
        expect(() => hpkeOpen(purpose, puk.secretKey, changed, box)).throws()
      }
      let hash = Buffer.from(
        join(Uint8Array.of(0), lp(senderIdentityKey), encoded(value))
      )
      for (let i = 0; i < 5200; i++)
        hash = createHash('sha512').update(hash).digest()
      const digits = Array.from({ length: 6 }, (_, at) =>
        String(hash.readUIntBE(at * 5, 5) % 100000).padStart(5, '0')
      ).join('')
      const party = { userId: id, identityKey: senderIdentityKey }
      expect(safetyHalf(party)).equals(digits)
      const otherParty = { userId: other, identityKey: senderIdentityKey }
      expect(safetyNumber(party, otherParty)).equals(
        safetyNumber(otherParty, party)
      )
      expect(safetyHalf(party)).not.equals(safetyHalf(otherParty))
    })
  }

  it('rejects alternate encodings and zero outside the nullable actor slot', () => {
    const taggedLow = Buffer.alloc(17)
    taggedLow[0] = 255
    taggedLow[16] = 7
    const wrongTag = encoded(1n << 64n).slice()
    wrongTag[0] = 1
    for (const invalid of [
      u64(0),
      u64(1n << 53n),
      taggedLow,
      wrongTag,
      new Uint8Array(0),
      new Uint8Array(16),
      new Uint8Array(18)
    ]) {
      expect(() => call('safetyHalf', [new Uint8Array(32), invalid])).throws(
        'malformed'
      )
    }
  })
})
