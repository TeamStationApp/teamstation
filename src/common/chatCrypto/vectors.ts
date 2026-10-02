import { bucketSize, lp, u64, utf8 } from './bytes'
import {
  openPreviousEpochKey,
  openPreviousPukKeys,
  sealPreviousEpochKey,
  sealPreviousPukKeys,
  signEpoch,
  signPuk,
  verifyEpoch,
  verifyPuk
} from './chain'
import {
  deriveKeyPair,
  epochAad,
  hpkeOpen,
  type HpkePurpose,
  hpkeSeal,
  linkAad,
  pukAad,
  setupBaseRecipient,
  setupBaseSender
} from './hpke'
import { signingPublicKey } from './keys'
import { linkCode } from './linkCode'
import { GENESIS_HASH, logRowHash } from './logHash'
import { primitives } from './primitives'
import { safetyNumber } from './safetyNumber'
import { messageKey, openMessage, sealMessage } from './seal'
import { openAttachment, sealAttachment } from './stream'

/**
 * The frozen vectors of every chat construction, in one place, for both
 * `primitives` twins.
 *
 * Node's tests run `runVectors()` on `primitives.ts` (`@noble`); the bench
 * screen runs the same function on a phone, where the constructions sit on
 * `primitives.native.ts`, and shows `vectors ok` only when every one matches.
 * Same inputs, same bytes: that is what makes the two twins one protocol.
 *
 * The inputs are fixed: `seed(label)` is SHA-256 of the label's UTF-8, and
 * every nonce, ephemeral key and attachment key is one of those.
 */

export const RFC9180_A21 = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  ikmE: '909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b',
  pkEm: '1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a',
  ikmR: '1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df',
  pkRm: '4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a',
  skRm: '8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb',
  key: 'ad2744de8e17f4ebba575b3f5f5a8fa1f69c2a07f6e7500bc60ca6e3e3ec1c91',
  baseNonce: '5c4d98150661b848853b547f',
  exporterSecret:
    'a3b010d4994890e2c6968a36f64470d3c824c8f5029942feb11e7a74b2921922',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  aad0: '436f756e742d30',
  ct0: '1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28',
  exported: '4bbd6243b8bb54cec311fac9df81841b6fd61f56538a775e7c80a9f40160606e'
}

const ENC = '38ff04839d19ad92c220357905218a66d628ecdca265542fb8ac0f1793f1bc0e'

export const FROZEN = {
  recipientPublicKey:
    'c085cb25d725d21ebe6829a45f7411d34589d3cb98021645d1dad603b09db550',
  identityPublicKey:
    '14724019b41f21093706e67cd4e4949ba35a4a7e8212324553a44bf9a61161d1',
  boxes: {
    link:
      ENC +
      '82c17def7b7792fb327c5ad1fa854fe2bbfdbe87f9f2e157c3c5c266b687f39ac4a2b6da2f3f75d8b269871a1cd26558',
    puk:
      ENC +
      '91add4593588d938c49643ed6b0713dfc15b17cae8df32197315015ae90117a4aee15c73943a55f30d85f40cf2f664a9',
    epoch:
      ENC +
      'b2dd728fdefb904e1ebb8d7eb2db616437f23787bee536f916c5f32cf83c60800bcede80689d61b1ecaa66805f63779b',
    grant:
      ENC +
      'b63ab985fe1d960a461b81322a7b5c1c60c3d4e0fd9360302eac12ca07fdbb60d82ca0926bfa25fc0cd9bf7f4e620143'
  } satisfies Record<HpkePurpose, string>,
  messageKey:
    'ac7dd49fdd7c2891d96f0e2f675eeff186816a038767f0e97b770cb163267875',
  sealCiphertextSha256:
    '51a66e8451ceeec51a33d5889b7a9bb33c3d083a04b8403388e4b9079ab2fbff',
  sealSignature:
    '02f1ba57fb0f065d3254b0b75fda2b5600d9c40ef0e78933da4ad52cda7ef10bed3ac6a6cff9e325161e54a6141916bd47007000de9c3fd49a471fb9e1f87401',
  streamSmallDigest:
    '7da7e9fee49f0c99e2e40d7d46d853e2b32dd9303bdb165d9931a871c58cb491',
  streamBigDigest:
    '76c6ce34c7b1aebd2f530f7d441de4d6243807a12866fe649abcec55ff0a3c08',
  previousKeyBox:
    '78377b525757b494427f89014f97d79928f3938d14eb51e2d6350a9cea1ec6c9d0b73bc9034183aa389aff40c6f086cd03cfce265739c885ba406537b2e841eb0b3c2d6816459cfe',
  epochSignature:
    'afc25f45cec1aa0977fd39f7a662d981a3acfeac82684ce182774aa31351e639ab85859d65221e8ee59543351ca1c85a45f40b8eb44690868f47ab82edd77c0f',
  firstEpochSignature:
    'a62bb2e0be154433dc2e18bd91c330fba2590ae3968e02a227cbf38f2f1993d87f1776d1c3b36a703e1bf7a8ddca5ec24706058297ccb2b84e7f00609abe6302',
  previousKeysBox:
    '78377b525757b494427f89014f97d79928f3938d14eb51e2c18aaa38f37a3965de369680811e553f3dcfdcffabf35f22f13fc7b4fb83eed466002c6e529e4baff42133d92913efb07113b5eabaeabac72d97ab30aa6cddb3a8de1cc1aa17d844c4077d50b95df531ac90711de13e3947fa6161fb40cdcd12b62cda1f8dc049ed',
  pukSignature:
    '694f703f0f82076daa553d161de7eecd3ed4fc71052add4005e1502d552de0339476521a90eb8662a01c6a585ae95a2fe3a76ae1047e143f95c084cfdc33620d',
  logHashes: [
    'a06197e2e1cff700d015ab1eb4c8e8f0ff78224a029740fbe047b36f5d6d56f5',
    'bd02e848aa22160bb0ee73ac597813f5ce3174626d846d7be0621ec385222f72'
  ],
  safetyNumber: '420693152042024233918378460099523999522228652791089056264003',
  linkCode: '134232'
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16)
  }
  return out
}

/** SHA-256 of a label: every fixed input below. */
export const seed = (label: string): Uint8Array =>
  primitives.sha256(utf8(label))

export interface VectorResult {
  name: string
  ok: boolean
  got: string
  want: string
}

/** Every vector, run on whichever `primitives` this platform has. */
export function runVectors(): VectorResult[] {
  const results: VectorResult[] = []
  const check = (name: string, got: () => string, want: string): void => {
    let value: string
    try {
      value = got()
    } catch (caught: unknown) {
      value = `threw ${caught instanceof Error ? caught.message : String(caught)}`
    }
    results.push({ name, ok: value === want, got: value, want })
  }

  // bytes.ts
  check('lp', () => toHex(lp('é🎉')), '00000006c3a9f09f8e89')
  check('u64', () => toHex(u64(1234567890123)), '0000011f71fb04cb')
  check('bucket 541', () => String(bucketSize(541)), '569')
  check('bucket 20 MiB', () => String(bucketSize(20971520)), '21453467')

  // hpke.ts: RFC 9180 A.2.1
  const rfc = RFC9180_A21
  check(
    'RFC 9180 DeriveKeyPair',
    () => toHex(deriveKeyPair(fromHex(rfc.ikmE)).publicKey),
    rfc.pkEm
  )
  check(
    'RFC 9180 sender key schedule',
    () => {
      const { context } = setupBaseSender(
        fromHex(rfc.pkRm),
        fromHex(rfc.info),
        fromHex(rfc.ikmE)
      )
      return [context.key, context.baseNonce, context.exporterSecret]
        .map(toHex)
        .join(' ')
    },
    `${rfc.key} ${rfc.baseNonce} ${rfc.exporterSecret}`
  )
  check(
    'RFC 9180 seal 0',
    () =>
      toHex(
        setupBaseSender(
          fromHex(rfc.pkRm),
          fromHex(rfc.info),
          fromHex(rfc.ikmE)
        ).context.seal(fromHex(rfc.aad0), fromHex(rfc.pt))
      ),
    rfc.ct0
  )
  check(
    'RFC 9180 open 0 and export',
    () => {
      const context = setupBaseRecipient(
        fromHex(rfc.pkEm),
        fromHex(rfc.skRm),
        fromHex(rfc.info)
      )
      const opened = context.open(fromHex(rfc.aad0), fromHex(rfc.ct0))
      return `${toHex(opened)} ${toHex(context.export(new Uint8Array(0), 32))}`
    },
    `${rfc.pt} ${rfc.exported}`
  )

  // hpke.ts: the four chat purposes
  const recipient = deriveKeyPair(seed('recipient'))
  check(
    'recipient key',
    () => toHex(recipient.publicKey),
    FROZEN.recipientPublicKey
  )
  const aads: Record<HpkePurpose, Uint8Array> = {
    link: linkAad({ linkId: 'clk_link1', newDeviceId: 'cdv_dev2' }),
    puk: pukAad({
      userId: 42,
      identityId: 'cid_1',
      generation: 3,
      deviceId: 'cdv_dev2'
    }),
    epoch: epochAad({
      conversationId: 'cnv_c1',
      epoch: 7,
      recipientUserId: 42,
      identityId: 'cid_1',
      generation: 3
    }),
    grant: epochAad({
      conversationId: 'cnv_c1',
      epoch: 7,
      recipientUserId: 42,
      identityId: 'cid_1',
      generation: 3
    })
  }
  const epochKey = seed('epoch key')
  for (const purpose of ['link', 'puk', 'epoch', 'grant'] as const) {
    check(
      `HPKE ${purpose}`,
      () =>
        toHex(
          hpkeSeal(
            purpose,
            recipient.publicKey,
            aads[purpose],
            epochKey,
            seed('ephemeral')
          )
        ),
      FROZEN.boxes[purpose]
    )
    check(
      `HPKE ${purpose} open`,
      () =>
        toHex(
          hpkeOpen(
            purpose,
            recipient.secretKey,
            aads[purpose],
            fromHex(FROZEN.boxes[purpose])
          )
        ),
      toHex(epochKey)
    )
  }

  // seal.ts
  const identity = seed('identity')
  const identityKey = signingPublicKey(identity)
  check('identity key', () => toHex(identityKey), FROZEN.identityPublicKey)
  const fields = {
    conversationId: 'cnv_c1',
    epoch: 7,
    messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    senderUserId: 42,
    kind: 'post' as const
  }
  check(
    'message key',
    () => toHex(messageKey(epochKey, 'cnv_c1', fields.messageId)),
    FROZEN.messageKey
  )
  const plaintext = utf8(
    '{"type":"text","body":"hi 🎉","mentions":[],"attachments":[]}'
  )
  const nonce = seed('nonce').subarray(0, 24)
  check(
    'seal',
    () => {
      const sealed = sealMessage({
        ...fields,
        epochKey,
        plaintext,
        identitySecretKey: identity,
        nonce
      })
      return `${toHex(primitives.sha256(sealed.ciphertext))} ${toHex(sealed.signature)}`
    },
    `${FROZEN.sealCiphertextSha256} ${FROZEN.sealSignature}`
  )
  check(
    'seal open',
    () => {
      const sealed = sealMessage({
        ...fields,
        epochKey,
        plaintext,
        identitySecretKey: identity,
        nonce
      })
      return toHex(
        openMessage({
          ...fields,
          ...sealed,
          epochKey,
          senderIdentityKey: identityKey
        })
      )
    },
    toHex(plaintext)
  )

  // stream.ts
  const streamOptions = {
    key: seed('attachment key'),
    prefix: seed('prefix').subarray(0, 16)
  }
  check(
    'stream small',
    () => toHex(sealAttachment(utf8('hello attachment'), streamOptions).digest),
    FROZEN.streamSmallDigest
  )
  const big = new Uint8Array(200000)
  for (let i = 0; i < big.length; i++) big[i] = i % 251
  check(
    'stream several chunks, round trip',
    () => {
      const sealed = sealAttachment(big, streamOptions)
      const opened = openAttachment(
        streamOptions.key,
        sealed.blob,
        sealed.digest
      )
      return `${toHex(sealed.digest)} ${toHex(primitives.sha256(opened))}`
    },
    `${FROZEN.streamBigDigest} ${toHex(primitives.sha256(big))}`
  )

  // chain.ts
  const epoch8 = seed('epoch 8')
  check(
    'previous_key_box',
    () =>
      toHex(
        sealPreviousEpochKey({
          conversationId: 'cnv_c1',
          epoch: 8,
          epochKey: epoch8,
          previousEpochKey: epochKey,
          nonce
        })
      ),
    FROZEN.previousKeyBox
  )
  check(
    'previous_key_box open',
    () =>
      toHex(
        openPreviousEpochKey({
          conversationId: 'cnv_c1',
          epoch: 8,
          epochKey: epoch8,
          previousKeyBox: fromHex(FROZEN.previousKeyBox)
        })
      ),
    toHex(epochKey)
  )
  const epochFields = {
    conversationId: 'cnv_c1',
    epoch: 8,
    previousKeyBox: fromHex(FROZEN.previousKeyBox)
  }
  check(
    'epoch signature',
    () => toHex(signEpoch(epochFields, identity)),
    FROZEN.epochSignature
  )
  check(
    'first epoch signature',
    () =>
      toHex(
        signEpoch(
          { conversationId: 'cnv_c1', epoch: 1, previousKeyBox: null },
          identity
        )
      ),
    FROZEN.firstEpochSignature
  )
  check(
    'epoch signature verifies, and not for another epoch',
    () =>
      [
        verifyEpoch(epochFields, fromHex(FROZEN.epochSignature), identityKey),
        verifyEpoch(
          { ...epochFields, epoch: 9 },
          fromHex(FROZEN.epochSignature),
          identityKey
        )
      ].join(' '),
    'true false'
  )
  const pukFields = {
    userId: 42,
    identityId: 'cid_1',
    generation: 3,
    privateKey: seed('puk 3')
  }
  check(
    'previous_keys_box',
    () =>
      toHex(
        sealPreviousPukKeys({
          ...pukFields,
          older: [
            { generation: 2, privateKey: seed('puk 2') },
            { generation: 1, privateKey: seed('puk 1') }
          ],
          nonce
        })
      ),
    FROZEN.previousKeysBox
  )
  check(
    'previous_keys_box open',
    () =>
      openPreviousPukKeys({
        ...pukFields,
        previousKeysBox: fromHex(FROZEN.previousKeysBox)
      })
        .map(key => `${key.generation}:${toHex(key.privateKey)}`)
        .join(' '),
    `1:${toHex(seed('puk 1'))} 2:${toHex(seed('puk 2'))}`
  )
  const pukSigned = {
    userId: 42,
    generation: 3,
    publicKey: recipient.publicKey
  }
  check(
    'PUK signature',
    () => toHex(signPuk(pukSigned, identity)),
    FROZEN.pukSignature
  )
  check(
    'PUK signature verifies, and not from another identity',
    () =>
      [
        verifyPuk(pukSigned, fromHex(FROZEN.pukSignature), identityKey),
        verifyPuk(
          pukSigned,
          fromHex(FROZEN.pukSignature),
          signingPublicKey(seed('identity 7'))
        )
      ].join(' '),
    'true false'
  )

  // logHash.ts
  check(
    'log hash chain',
    () => {
      const first = logRowHash(GENESIS_HASH, {
        conversationId: 'cnv_c1',
        seq: 1,
        event: 'join',
        userId: 42,
        actorUserId: null,
        reason: null,
        at: 1790000000000
      })
      const second = logRowHash(first, {
        conversationId: 'cnv_c1',
        seq: 2,
        event: 'leave',
        userId: 42,
        actorUserId: 7,
        reason: 'notEligible',
        at: 1790000001000
      })
      return `${toHex(first)} ${toHex(second)}`
    },
    FROZEN.logHashes.join(' ')
  )

  // safetyNumber.ts, linkCode.ts
  check(
    'safety number',
    () =>
      safetyNumber(
        { userId: 42, identityKey },
        { userId: 7, identityKey: signingPublicKey(seed('identity 7')) }
      ),
    FROZEN.safetyNumber
  )
  check(
    'link code',
    () => linkCode(recipient.publicKey, 'clk_link1'),
    FROZEN.linkCode
  )
  return results
}

/**
 * `vectors ok`, or the first that did not match. A primitive that throws
 * while the fixed inputs are being made is a failure too, never a crash.
 */
export function vectorSummary(results?: VectorResult[]): string {
  let checked: VectorResult[]
  try {
    checked = results ?? runVectors()
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught)
    return `vectors failed: threw ${message}`
  }
  const failed = checked.find(result => !result.ok)
  return failed == null
    ? 'vectors ok'
    : `vectors failed: ${failed.name} (got ${failed.got.slice(0, 40)})`
}
