import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { expect } from 'chai'
import { describe, it } from 'mocha'

import { utf8 } from './bytes'
import {
  deriveKeyPair,
  epochAad,
  hpkeInfo,
  hpkeOpen,
  type HpkePurpose,
  hpkeSeal,
  linkAad,
  pukAad,
  setupBaseRecipient,
  setupBaseSender
} from './hpke'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const fromHex = (text: string): Uint8Array =>
  Uint8Array.from(Buffer.from(text.replace(/\s+/g, ''), 'hex'))
const seed = (label: string): Uint8Array => sha256(utf8(label))

/**
 * RFC 9180 Appendix A.2.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
 * ChaCha20Poly1305, base mode.
 */
const A21 = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  ikmE: '909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b',
  pkEm: '1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a',
  skEm: 'f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600',
  ikmR: '1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df',
  pkRm: '4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a',
  skRm: '8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb',
  enc: '1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a',
  key: 'ad2744de8e17f4ebba575b3f5f5a8fa1f69c2a07f6e7500bc60ca6e3e3ec1c91',
  baseNonce: '5c4d98150661b848853b547f',
  exporterSecret:
    'a3b010d4994890e2c6968a36f64470d3c824c8f5029942feb11e7a74b2921922',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  encryptions: [
    {
      seq: 0,
      aad: '436f756e742d30',
      ct: '1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28'
    },
    {
      seq: 1,
      aad: '436f756e742d31',
      ct: '6b53c051e4199c518de79594e1c4ab18b96f081549d45ce015be002090bb119e85285337cc95ba5f59992dc98c'
    },
    {
      seq: 2,
      aad: '436f756e742d32',
      ct: '71146bd6795ccc9c49ce25dda112a48f202ad220559502cef1f34271e0cb4b02b4f10ecac6f48c32f878fae86b'
    },
    {
      seq: 4,
      aad: '436f756e742d34',
      ct: '63357a2aa291f5a4e5f27db6baa2af8cf77427c7c1a909e0b37214dd47db122bb153495ff0b02e9e54a50dbe16'
    },
    {
      seq: 255,
      aad: '436f756e742d323535',
      ct: '18ab939d63ddec9f6ac2b60d61d36a7375d2070c9b683861110757062c52b8880a5f6b3936da9cd6c23ef2a95c'
    },
    {
      seq: 256,
      aad: '436f756e742d323536',
      ct: '7a4a13e9ef23978e2c520fd4d2e757514ae160cd0cd05e556ef692370ca53076214c0c40d4c728d6ed9e727a5b'
    }
  ],
  exports: [
    {
      context: '',
      value: '4bbd6243b8bb54cec311fac9df81841b6fd61f56538a775e7c80a9f40160606e'
    },
    {
      context: '00',
      value: '8c1df14732580e5501b00f82b10a1647b40713191b7c1240ac80e2b68808ba69'
    },
    {
      context: '54657374436f6e74657874',
      value: '5acb09211139c43b3090489a9da433e8a30ee7188ba8b0a9a1ccf0c229283e53'
    }
  ]
}

describe('chatCrypto HPKE', () => {
  describe('RFC 9180 A.2.1 vectors', () => {
    it('derives both key pairs', () => {
      const e = deriveKeyPair(fromHex(A21.ikmE))
      expect(hex(e.secretKey)).equals(A21.skEm)
      expect(hex(e.publicKey)).equals(A21.pkEm)
      const r = deriveKeyPair(fromHex(A21.ikmR))
      expect(hex(r.secretKey)).equals(A21.skRm)
      expect(hex(r.publicKey)).equals(A21.pkRm)
    })

    it('sets up the sender: enc, key, base nonce, exporter secret', () => {
      const { enc, context } = setupBaseSender(
        fromHex(A21.pkRm),
        fromHex(A21.info),
        fromHex(A21.ikmE)
      )
      expect(hex(enc)).equals(A21.enc)
      expect(hex(context.key)).equals(A21.key)
      expect(hex(context.baseNonce)).equals(A21.baseNonce)
      expect(hex(context.exporterSecret)).equals(A21.exporterSecret)
    })

    it('seals every sequence number to the RFC ciphertext', () => {
      const { context } = setupBaseSender(
        fromHex(A21.pkRm),
        fromHex(A21.info),
        fromHex(A21.ikmE)
      )
      for (const one of A21.encryptions) {
        context.setSequence(one.seq)
        expect(hex(context.seal(fromHex(one.aad), fromHex(A21.pt)))).equals(
          one.ct
        )
      }
    })

    it('opens every RFC ciphertext as the recipient', () => {
      const context = setupBaseRecipient(
        fromHex(A21.enc),
        fromHex(A21.skRm),
        fromHex(A21.info)
      )
      expect(hex(context.key)).equals(A21.key)
      for (const one of A21.encryptions) {
        context.setSequence(one.seq)
        expect(hex(context.open(fromHex(one.aad), fromHex(one.ct)))).equals(
          A21.pt
        )
      }
    })

    it('moves the sequence on by itself, from 0', () => {
      const { context } = setupBaseSender(
        fromHex(A21.pkRm),
        fromHex(A21.info),
        fromHex(A21.ikmE)
      )
      const [first, second, third] = A21.encryptions
      expect(hex(context.seal(fromHex(first.aad), fromHex(A21.pt)))).equals(
        first.ct
      )
      expect(hex(context.seal(fromHex(second.aad), fromHex(A21.pt)))).equals(
        second.ct
      )
      expect(hex(context.seal(fromHex(third.aad), fromHex(A21.pt)))).equals(
        third.ct
      )
    })

    it('exports the RFC values', () => {
      const context = setupBaseRecipient(
        fromHex(A21.enc),
        fromHex(A21.skRm),
        fromHex(A21.info)
      )
      for (const one of A21.exports) {
        expect(hex(context.export(fromHex(one.context), 32))).equals(one.value)
      }
    })
  })

  describe('chat boxes', () => {
    const recipient = deriveKeyPair(seed('recipient'))
    const plaintext = seed('epoch key')
    const ephemeral = seed('ephemeral')
    const link = linkAad({ linkId: 'clk_link1', newDeviceId: 'cdv_dev2' })
    const puk = pukAad({
      userId: 42,
      identityId: 'cid_1',
      generation: 3,
      deviceId: 'cdv_dev2'
    })
    const epoch = epochAad({
      conversationId: 'cnv_c1',
      epoch: 7,
      recipientUserId: 42,
      identityId: 'cid_1',
      generation: 3
    })
    const enc =
      '38ff04839d19ad92c220357905218a66d628ecdca265542fb8ac0f1793f1bc0e'
    const frozen: Array<[HpkePurpose, Uint8Array, string]> = [
      [
        'link',
        link,
        enc +
          '82c17def7b7792fb327c5ad1fa854fe2bbfdbe87f9f2e157c3c5c266b687f39ac4a2b6da2f3f75d8b269871a1cd26558'
      ],
      [
        'puk',
        puk,
        enc +
          '91add4593588d938c49643ed6b0713dfc15b17cae8df32197315015ae90117a4aee15c73943a55f30d85f40cf2f664a9'
      ],
      [
        'epoch',
        epoch,
        enc +
          'b2dd728fdefb904e1ebb8d7eb2db616437f23787bee536f916c5f32cf83c60800bcede80689d61b1ecaa66805f63779b'
      ],
      [
        'grant',
        epoch,
        enc +
          'b63ab985fe1d960a461b81322a7b5c1c60c3d4e0fd9360302eac12ca07fdbb60d82ca0926bfa25fc0cd9bf7f4e620143'
      ]
    ]

    it('info is "ts-chat/v1/" and the purpose', () => {
      expect(Buffer.from(hpkeInfo('grant')).toString()).equals(
        'ts-chat/v1/grant'
      )
    })

    it('AADs: frozen vectors', () => {
      expect(hex(link)).equals(
        '00000009' +
          Buffer.from('clk_link1').toString('hex') +
          '00000008' +
          Buffer.from('cdv_dev2').toString('hex')
      )
      expect(hex(puk)).equals(
        '000000000000002a' +
          '00000005' +
          Buffer.from('cid_1').toString('hex') +
          '0000000000000003' +
          '00000008' +
          Buffer.from('cdv_dev2').toString('hex')
      )
      expect(hex(epoch)).equals(
        '00000006' +
          Buffer.from('cnv_c1').toString('hex') +
          '0000000000000007' +
          '000000000000002a' +
          '00000005' +
          Buffer.from('cid_1').toString('hex') +
          '0000000000000003'
      )
    })

    it('boxes of each purpose with a fixed ephemeral key: frozen vectors', () => {
      for (const [purpose, aad, box] of frozen) {
        expect(
          hex(
            hpkeSeal(purpose, recipient.publicKey, aad, plaintext, ephemeral)
          ),
          purpose
        ).equals(box)
        expect(
          hex(hpkeOpen(purpose, recipient.secretKey, aad, fromHex(box))),
          purpose
        ).equals(hex(plaintext))
      }
    })

    it('a random ephemeral key round-trips and differs every time', () => {
      const one = hpkeSeal('epoch', recipient.publicKey, epoch, plaintext)
      const two = hpkeSeal('epoch', recipient.publicKey, epoch, plaintext)
      expect(hex(one)).not.equals(hex(two))
      expect(hex(hpkeOpen('epoch', recipient.secretKey, epoch, one))).equals(
        hex(plaintext)
      )
    })

    it('refuses the wrong purpose, AAD, key, or a changed byte', () => {
      const box = fromHex(frozen[2][2])
      expect(() => hpkeOpen('grant', recipient.secretKey, epoch, box)).throws()
      const otherEpoch = epochAad({
        conversationId: 'cnv_c1',
        epoch: 8,
        recipientUserId: 42,
        identityId: 'cid_1',
        generation: 3
      })
      expect(() =>
        hpkeOpen('epoch', recipient.secretKey, otherEpoch, box)
      ).throws()
      expect(() => hpkeOpen('epoch', seed('someone else'), epoch, box)).throws()
      for (const at of [0, 40, box.length - 1]) {
        const changed = box.slice()
        changed[at] ^= 1
        expect(() =>
          hpkeOpen('epoch', recipient.secretKey, epoch, changed)
        ).throws()
      }
      expect(() =>
        hpkeOpen('epoch', recipient.secretKey, epoch, box.subarray(0, 47))
      ).throws(TypeError, 'too short')
      expect(() =>
        setupBaseRecipient(box.subarray(0, 31), recipient.secretKey, epoch)
      ).throws(TypeError, '32 bytes')
    })

    it('refuses a small-order public key (an all-zero shared secret)', () => {
      const zero = new Uint8Array(32)
      expect(() => hpkeSeal('epoch', zero, epoch, plaintext)).throws()
      expect(x25519.getPublicKey(recipient.secretKey).length).equals(32)
    })
  })
})
