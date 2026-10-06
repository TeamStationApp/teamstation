import { hkdfSync } from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { fromHex, hex, oracle, seed } from '../../test/chatCryptoOracle'
import {
  epochSignedBytes,
  openPreviousEpochKey,
  openPreviousPukKeys,
  pukSignedBytes,
  sealPreviousEpochKey,
  sealPreviousPukKeys,
  signEpoch,
  signPuk,
  verifyEpoch,
  verifyPuk
} from './chain'
import { deriveKeyPair } from './hpke'
import { signingPublicKey } from './keys'

const identity = seed('identity')
const identityKey = signingPublicKey(identity)
const nonce = seed('nonce').subarray(0, 24)
const epochKey = seed('epoch key')
const epoch8 = seed('epoch 8')

const PREV_EPOCH =
  '78377b525757b494427f89014f97d79928f3938d14eb51e2d6350a9cea1ec6c9d0b73bc9034183aa389aff40c6f086cd03cfce265739c885ba406537b2e841eb0b3c2d6816459cfe'
const PREV_PUK =
  '78377b525757b494427f89014f97d79928f3938d14eb51e2c18aaa38f37a3965de369680811e553f3dcfdcffabf35f22f13fc7b4fb83eed466002c6e529e4baff42133d92913efb07113b5eabaeabac72d97ab30aa6cddb3a8de1cc1aa17d844c4077d50b95df531ac90711de13e3947fa6161fb40cdcd12b62cda1f8dc049ed'

describe('chatCrypto chain', () => {
  describe('epochs', () => {
    const box = sealPreviousEpochKey({
      conversationId: 'cnv_c1',
      epoch: 8,
      epochKey: epoch8,
      previousEpochKey: epochKey,
      nonce
    })

    it('previous_key_box: frozen vector', () => {
      expect(hex(box)).equals(PREV_EPOCH)
    })

    it('is XChaCha20-Poly1305 under HKDF(epoch n key, "ts-chat/v1/prev-epoch"), checked with Node’s HKDF', () => {
      const key = hkdfSync(
        'sha256',
        epoch8,
        new Uint8Array(0),
        Buffer.from('ts-chat/v1/prev-epoch'),
        32
      )
      const aad = fromHex(
        '00000006' + Buffer.from('cnv_c1').toString('hex') + '0000000000000008'
      )
      const opened = oracle.xchacha20Poly1305Open(
        new Uint8Array(key),
        nonce,
        aad,
        box.subarray(24)
      )
      expect(hex(opened)).equals(hex(epochKey))
    })

    it('epoch n’s key opens epoch n−1’s', () => {
      const opened = openPreviousEpochKey({
        conversationId: 'cnv_c1',
        epoch: 8,
        epochKey: epoch8,
        previousKeyBox: box
      })
      expect(hex(opened)).equals(hex(epochKey))
    })

    it('a random nonce round-trips', () => {
      const random = sealPreviousEpochKey({
        conversationId: 'cnv_c1',
        epoch: 8,
        epochKey: epoch8,
        previousEpochKey: epochKey
      })
      expect(hex(random)).not.equals(PREV_EPOCH)
      expect(
        hex(
          openPreviousEpochKey({
            conversationId: 'cnv_c1',
            epoch: 8,
            epochKey: epoch8,
            previousKeyBox: random
          })
        )
      ).equals(hex(epochKey))
    })

    it('refuses another conversation, epoch, key or a changed byte', () => {
      const open = (change: object): Uint8Array =>
        openPreviousEpochKey({
          conversationId: 'cnv_c1',
          epoch: 8,
          epochKey: epoch8,
          previousKeyBox: box,
          ...change
        })
      expect(() => open({ conversationId: 'cnv_c2' })).throws()
      expect(() => open({ epoch: 9 })).throws()
      expect(() => open({ epochKey })).throws()
      const changed = box.slice()
      changed[30] ^= 1
      expect(() => open({ previousKeyBox: changed })).throws()
      expect(() => open({ previousKeyBox: box.subarray(0, 39) })).throws(
        'too short'
      )
    })

    it('the epoch signature: frozen vectors, with and without a box', () => {
      const fields = {
        conversationId: 'cnv_c1',
        epoch: 8,
        previousKeyBox: box
      }
      expect(hex(epochSignedBytes(fields))).equals(
        '00000006' +
          Buffer.from('cnv_c1').toString('hex') +
          '0000000000000008' +
          hex(oracle.sha256(box))
      )
      const signature = signEpoch(fields, identity)
      expect(hex(signature)).equals(
        'afc25f45cec1aa0977fd39f7a662d981a3acfeac82684ce182774aa31351e639ab85859d65221e8ee59543351ca1c85a45f40b8eb44690868f47ab82edd77c0f'
      )
      expect(verifyEpoch(fields, signature, identityKey)).equals(true)

      const first = { conversationId: 'cnv_c1', epoch: 1, previousKeyBox: null }
      expect(
        hex(epochSignedBytes(first)).endsWith(
          hex(oracle.sha256(new Uint8Array(0)))
        )
      ).equals(true)
      const firstSignature = signEpoch(first, identity)
      expect(hex(firstSignature)).equals(
        'a62bb2e0be154433dc2e18bd91c330fba2590ae3968e02a227cbf38f2f1993d87f1776d1c3b36a703e1bf7a8ddca5ec24706058297ccb2b84e7f00609abe6302'
      )
      expect(verifyEpoch(first, firstSignature, identityKey)).equals(true)
    })

    it('an epoch signature fails for another identity, epoch or box', () => {
      const fields = {
        conversationId: 'cnv_c1',
        epoch: 8,
        previousKeyBox: box
      }
      const signature = signEpoch(fields, identity)
      expect(
        verifyEpoch(fields, signature, signingPublicKey(seed('identity 7')))
      ).equals(false)
      expect(
        verifyEpoch({ ...fields, epoch: 9 }, signature, identityKey)
      ).equals(false)
      expect(
        verifyEpoch(
          { ...fields, previousKeyBox: box.slice(1) },
          signature,
          identityKey
        )
      ).equals(false)
      expect(
        verifyEpoch(fields, signEpoch(fields, seed('identity 7')), identityKey)
      ).equals(false)
    })
  })

  describe('per-user keys', () => {
    const puk3 = seed('puk 3')
    const older = [
      { generation: 2, privateKey: seed('puk 2') },
      { generation: 1, privateKey: seed('puk 1') }
    ]
    const box = sealPreviousPukKeys({
      userId: 42,
      identityId: 'cid_1',
      generation: 3,
      privateKey: puk3,
      older,
      nonce
    })
    const open = (
      change: object = {}
    ): ReturnType<typeof openPreviousPukKeys> =>
      openPreviousPukKeys({
        userId: 42,
        identityId: 'cid_1',
        generation: 3,
        privateKey: puk3,
        previousKeysBox: box,
        ...change
      })

    it('previous_keys_box: frozen vector', () => {
      expect(hex(box)).equals(PREV_PUK)
    })

    it('holds u64(generation) ‖ lp(privateKey) for each, oldest first', () => {
      const key = hkdfSync(
        'sha256',
        puk3,
        new Uint8Array(0),
        Buffer.from('ts-chat/v1/prev-puk'),
        32
      )
      const aad = fromHex(
        '000000000000002a' +
          '00000005' +
          Buffer.from('cid_1').toString('hex') +
          '0000000000000003'
      )
      const plaintext = oracle.xchacha20Poly1305Open(
        new Uint8Array(key),
        nonce,
        aad,
        box.subarray(24)
      )
      expect(hex(plaintext)).equals(
        '0000000000000001' +
          '00000020' +
          hex(seed('puk 1')) +
          '0000000000000002' +
          '00000020' +
          hex(seed('puk 2'))
      )
    })

    it('opens to the older keys, oldest first', () => {
      const keys = open()
      expect(keys.map(one => one.generation)).deep.equals([1, 2])
      expect(hex(keys[0].privateKey)).equals(hex(seed('puk 1')))
      expect(hex(keys[1].privateKey)).equals(hex(seed('puk 2')))
    })

    it('a generation with nothing older carries an empty list', () => {
      const empty = sealPreviousPukKeys({
        userId: 42,
        identityId: 'cid_1',
        generation: 1,
        privateKey: puk3,
        older: []
      })
      expect(
        openPreviousPukKeys({
          userId: 42,
          identityId: 'cid_1',
          generation: 1,
          privateKey: puk3,
          previousKeysBox: empty
        })
      ).deep.equals([])
    })

    it('refuses another user, identity, generation, key or a changed byte', () => {
      expect(() => open({ userId: 43 })).throws()
      expect(() => open({ identityId: 'cid_2' })).throws()
      expect(() => open({ generation: 4 })).throws()
      expect(() => open({ privateKey: seed('puk 2') })).throws()
      const changed = box.slice()
      changed[50] ^= 1
      expect(() => open({ previousKeysBox: changed })).throws()
    })

    it('refuses a well-sealed list that is cut short', () => {
      // Sealed by hand, so the box opens and the list inside is what is wrong.
      const key = new Uint8Array(
        hkdfSync(
          'sha256',
          puk3,
          new Uint8Array(0),
          Buffer.from('ts-chat/v1/prev-puk'),
          32
        )
      )
      const aad = fromHex(
        '000000000000002a' +
          '00000005' +
          Buffer.from('cid_1').toString('hex') +
          '0000000000000003'
      )
      const seal = (plaintext: string): Uint8Array =>
        Uint8Array.from([
          ...nonce,
          ...oracle.xchacha20Poly1305Seal(key, nonce, aad, fromHex(plaintext))
        ])
      expect(() => open({ previousKeysBox: seal('0000000000000001') })).throws(
        'cut short'
      )
      expect(() =>
        open({ previousKeysBox: seal('000000000000000100000020ab') })
      ).throws('cut short')
      // Shorter than a nonce and a tag: refused before the core is asked.
      expect(() => open({ previousKeysBox: new Uint8Array(39) })).throws(
        TypeError,
        'too short'
      )
    })

    it('the PUK signature: frozen vector', () => {
      const publicKey = deriveKeyPair(seed('recipient')).publicKey
      const fields = { userId: 42, generation: 3, publicKey }
      expect(hex(pukSignedBytes(fields))).equals(
        '000000000000002a' + '0000000000000003' + '00000020' + hex(publicKey)
      )
      const signature = signPuk(fields, identity)
      expect(hex(signature)).equals(
        '694f703f0f82076daa553d161de7eecd3ed4fc71052add4005e1502d552de0339476521a90eb8662a01c6a585ae95a2fe3a76ae1047e143f95c084cfdc33620d'
      )
      expect(verifyPuk(fields, signature, identityKey)).equals(true)
      expect(
        verifyPuk({ ...fields, generation: 4 }, signature, identityKey)
      ).equals(false)
      expect(
        verifyPuk(fields, signature, signingPublicKey(seed('identity 7')))
      ).equals(false)
    })
  })
})
