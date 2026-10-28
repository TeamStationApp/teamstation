import { createPublicKey, hkdfSync, verify as nodeVerify } from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { hex, oracle, seed } from '../../test/chatCryptoOracle'
import { userIdOfGumbo } from '../userId'
import { utf8 } from './bytes'
import { signingPublicKey } from './keys'
import {
  bucketSize,
  ENVELOPE_KINDS,
  messageAad,
  type MessageFields,
  messageKey,
  openMessage,
  openWithMessageKey,
  sealMessage,
  signedDigest,
  verifyMessage
} from './seal'

const identity = seed('identity')
const identityKey = signingPublicKey(identity)
const epochKey = seed('epoch key')
const fields: MessageFields = {
  conversationId: 'cnv_c1',
  epoch: 7,
  messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  senderUserId: userIdOfGumbo(42),
  kind: 'post'
}
const plaintext = utf8(
  '{"type":"text","body":"hi 🎉","mentions":[],"attachments":[]}'
)
const nonce = seed('nonce').subarray(0, 24)
const sealed = sealMessage({
  ...fields,
  epochKey,
  plaintext,
  identitySecretKey: identity,
  nonce
})

/** Ed25519 through Node's own implementation, from a raw public key. */
function nodeVerifies(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKey)
    ]),
    format: 'der',
    type: 'spki'
  })
  return nodeVerify(null, message, key, signature)
}

describe('chatCrypto seal', () => {
  it('lists the five envelope kinds', () => {
    expect(ENVELOPE_KINDS).deep.equals([
      'post',
      'reaction',
      'edit',
      'delete',
      'moderatorDelete'
    ])
  })

  it('the AAD: frozen vector', () => {
    expect(hex(messageAad(fields))).equals(
      '00000006' +
        Buffer.from('cnv_c1').toString('hex') +
        '0000000000000007' +
        '0000001e' +
        Buffer.from(fields.messageId).toString('hex') +
        '000000000000002a' +
        '00000004' +
        Buffer.from('post').toString('hex')
    )
  })

  it('the message key is HKDF-SHA256 as written, checked against Node', () => {
    const key = messageKey(epochKey, 'cnv_c1', fields.messageId)
    expect(hex(key)).equals(
      'ac7dd49fdd7c2891d96f0e2f675eeff186816a038767f0e97b770cb163267875'
    )
    const node = hkdfSync(
      'sha256',
      epochKey,
      Buffer.from('cnv_c1'),
      Buffer.from(`ts-chat/v1/msg${fields.messageId}`),
      32
    )
    expect(hex(key)).equals(Buffer.from(node).toString('hex'))
  })

  it('seals to a frozen vector with a fixed nonce', () => {
    expect(hex(sealed.nonce)).equals(
      '78377b525757b494427f89014f97d79928f3938d14eb51e2'
    )
    expect(sealed.ciphertext.length).equals(541 + 16)
    expect(hex(sealed.ciphertext.subarray(0, 32))).equals(
      'e39d960c5314b67588ef5e85d648b40d755894f6d279f4de2b62beda888419f0'
    )
    expect(hex(oracle.sha256(sealed.ciphertext))).equals(
      '51a66e8451ceeec51a33d5889b7a9bb33c3d083a04b8403388e4b9079ab2fbff'
    )
    expect(hex(sealed.signature)).equals(
      '02f1ba57fb0f065d3254b0b75fda2b5600d9c40ef0e78933da4ad52cda7ef10bed3ac6a6cff9e325161e54a6141916bd47007000de9c3fd49a471fb9e1f87401'
    )
  })

  it('the signature is the identity key over SHA-256(aad ‖ nonce ‖ ciphertext), by Node too', () => {
    const digest = signedDigest(
      messageAad(fields),
      sealed.nonce,
      sealed.ciphertext
    )
    expect(nodeVerifies(digest, sealed.signature, identityKey)).equals(true)
  })

  it('opens what it sealed, padding removed', () => {
    const opened = openMessage({
      ...fields,
      ...sealed,
      epochKey,
      senderIdentityKey: identityKey
    })
    expect(hex(opened)).equals(hex(plaintext))
  })

  it('a random nonce round-trips and differs every time', () => {
    const one = sealMessage({
      ...fields,
      epochKey,
      plaintext,
      identitySecretKey: identity
    })
    const two = sealMessage({
      ...fields,
      epochKey,
      plaintext,
      identitySecretKey: identity
    })
    expect(hex(one.nonce)).not.equals(hex(two.nonce))
    expect(
      hex(
        openMessage({
          ...fields,
          ...one,
          epochKey,
          senderIdentityKey: identityKey
        })
      )
    ).equals(hex(plaintext))
  })

  it('pads a long message to its bucket', () => {
    const long = sealMessage({
      ...fields,
      epochKey,
      plaintext: new Uint8Array(541).fill(65),
      identitySecretKey: identity
    })
    expect(long.ciphertext.length).equals(569 + 16)
  })

  it('opens with the one message key, as a report does', () => {
    const opened = openWithMessageKey({
      ...fields,
      messageKey: messageKey(epochKey, fields.conversationId, fields.messageId),
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext
    })
    expect(hex(opened)).equals(hex(plaintext))
  })

  describe('tampering', () => {
    const open = (
      change: Partial<MessageFields> & {
        ciphertext?: Uint8Array
        nonce?: Uint8Array
        signature?: Uint8Array
        senderIdentityKey?: Uint8Array
        epochKey?: Uint8Array
      }
    ): Uint8Array =>
      openMessage({
        ...fields,
        ...sealed,
        epochKey,
        senderIdentityKey: identityKey,
        ...change
      })

    it('a flipped ciphertext byte fails', () => {
      for (const at of [0, 100, sealed.ciphertext.length - 1]) {
        const ciphertext = sealed.ciphertext.slice()
        ciphertext[at] ^= 0x01
        expect(() => open({ ciphertext })).throws('signature')
      }
    })

    it('a flipped ciphertext byte with a re-made signature still fails to open', () => {
      const ciphertext = sealed.ciphertext.slice()
      ciphertext[5] ^= 0x01
      const signature = sealMessage({
        ...fields,
        epochKey,
        plaintext,
        identitySecretKey: identity,
        nonce
      }).signature
      expect(() => open({ ciphertext, signature })).throws()
      expect(() =>
        openWithMessageKey({
          ...fields,
          messageKey: messageKey(epochKey, 'cnv_c1', fields.messageId),
          nonce,
          ciphertext
        })
      ).throws()
    })

    it('the wrong AAD fields fail: conversation, epoch, sender, kind, id', () => {
      const changes: Array<Partial<MessageFields>> = [
        { conversationId: 'cnv_c2' },
        { epoch: 8 },
        { senderUserId: userIdOfGumbo(43) },
        { kind: 'edit' },
        { messageId: 'msg_baaaaaaaaaaaaaaaaaaaaaaaaa' }
      ]
      for (const change of changes) {
        expect(() => open(change), JSON.stringify(change)).throws()
        // Even past the signature, the AEAD refuses it.
        expect(() =>
          openWithMessageKey({
            ...fields,
            ...change,
            messageKey: messageKey(epochKey, 'cnv_c1', fields.messageId),
            nonce,
            ciphertext: sealed.ciphertext
          })
        ).throws()
      }
    })

    it('a signature from another identity fails', () => {
      const other = seed('identity 7')
      const forged = sealMessage({
        ...fields,
        epochKey,
        plaintext,
        identitySecretKey: other,
        nonce
      })
      expect(hex(forged.ciphertext)).equals(hex(sealed.ciphertext))
      expect(() => open({ signature: forged.signature })).throws('signature')
      expect(
        verifyMessage({
          ...fields,
          ...forged,
          senderIdentityKey: signingPublicKey(other)
        })
      ).equals(true)
      expect(() => open({ senderIdentityKey: signingPublicKey(other) })).throws(
        'signature'
      )
    })

    it('a malformed signature is simply not valid', () => {
      expect(
        verifyMessage({
          ...fields,
          ...sealed,
          signature: new Uint8Array(3),
          senderIdentityKey: identityKey
        })
      ).equals(false)
    })

    it('the wrong epoch key fails', () => {
      expect(() => open({ epochKey: seed('another epoch') })).throws()
    })
  })

  describe('bucket sizes', () => {
    it('frozen vectors', () => {
      const table: Array<[number, number]> = [
        [0, 541],
        [1, 541],
        [539, 542],
        [540, 542],
        [541, 569],
        [542, 569],
        [560, 569],
        [1000, 1021],
        [8000, 8319],
        [65536, 67790],
        [20 * 1024 * 1024, 21453467]
      ]
      for (const [length, size] of table) {
        expect(bucketSize(length), String(length)).equals(size)
      }
    })

    it('follow max(541, ceil(1.05^ceil(log_1.05(n + 1))))', () => {
      for (let n = 0; n < 200000; n += n < 2000 ? 1 : 997) {
        const k = Math.ceil(Math.log(n + 1) / Math.log(1.05))
        const expected = Math.max(541, Math.ceil(1.05 ** k))
        expect(bucketSize(n), String(n)).equals(expected)
        expect(bucketSize(n)).greaterThan(n)
      }
      expect(() => bucketSize(-1)).throws(RangeError)
      expect(() => bucketSize(0.5)).throws(RangeError)
    })

    it('a sealed message is its bucket and a tag, at the edges', () => {
      // 540 bytes is the most a 542-byte bucket takes; 541 moves to the next.
      const lengthOf = (size: number): number =>
        sealMessage({
          ...fields,
          epochKey,
          plaintext: new Uint8Array(size).fill(7),
          identitySecretKey: identity
        }).ciphertext.length
      expect(lengthOf(0)).equals(541 + 16)
      expect(lengthOf(540)).equals(542 + 16)
      expect(lengthOf(541)).equals(569 + 16)
      // Content ending in the marker's own bytes comes back whole.
      const tricky = Uint8Array.of(1, 0, 0x80, 0)
      const sealedTricky = sealMessage({
        ...fields,
        epochKey,
        plaintext: tricky,
        identitySecretKey: identity
      })
      expect(
        hex(
          openWithMessageKey({
            ...fields,
            ...sealedTricky,
            messageKey: messageKey(epochKey, 'cnv_c1', fields.messageId)
          })
        )
      ).equals('01008000')
    })
  })
})
