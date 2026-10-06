import { lp, u64, utf8 } from './bytes'
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
import { call } from './core'
import { num } from './coreCall'
import vectorFile from './frozenVectors.json'
import { sha256 } from './hash'
import {
  deriveKeyPair,
  epochAad,
  hpkeOpen,
  type HpkePurpose,
  hpkeSeal,
  linkAad,
  pukAad
} from './hpke'
import { signingPublicKey } from './keys'
import { linkCode } from './linkCode'
import { GENESIS_HASH, logRowHash } from './logHash'
import { safetyNumber } from './safetyNumber'
import { bucketSize, messageKey, openMessage, sealMessage } from './seal'
import { openAttachment, sealAttachment } from './stream'

/**
 * The frozen vectors of every chat construction, in one place, through the
 * same TypeScript functions chat calls.
 *
 * Node's tests run `runVectors()` on the Node addon; the bench screen runs
 * it on a phone's native core and in a browser's WebAssembly, and shows
 * `vectors ok` only when every one matches. Same inputs, same bytes on every
 * platform: that is what makes the three builds of the core one protocol.
 *
 * The inputs are fixed: `seed(label)` is SHA-256 of the label's UTF-8, and
 * every nonce, ephemeral key and attachment key is one of those. The expected
 * bytes are in `frozenVectors.json`, which the Rust core's tests read too.
 */

export const RFC9180_A21 = vectorFile.rfc9180A21

export const FROZEN: typeof vectorFile.frozen & {
  boxes: Record<HpkePurpose, string>
} = vectorFile.frozen

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
export const seed = (label: string): Uint8Array => sha256(utf8(label))

export interface VectorResult {
  name: string
  ok: boolean
  got: string
  want: string
}

/** Every vector, run on this platform's chat crypto core. */
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
  // Nothing in chat keeps an HPKE context open: the RFC's sequence (the key
  // schedule, one seal and open under the RFC's ephemeral key, and an
  // export) runs through the core's own op.
  check(
    'RFC 9180 sequence',
    () =>
      call('hpkeVectorSequence', [
        fromHex(rfc.pkRm),
        fromHex(rfc.skRm),
        fromHex(rfc.info),
        fromHex(rfc.ikmE),
        fromHex(rfc.aad0),
        fromHex(rfc.pt),
        new Uint8Array(0),
        num(32)
      ])
        .map(toHex)
        .join(' '),
    [
      rfc.pkEm,
      rfc.key,
      rfc.baseNonce,
      rfc.exporterSecret,
      rfc.ct0,
      rfc.pt,
      rfc.exported
    ].join(' ')
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
      return `${toHex(sha256(sealed.ciphertext))} ${toHex(sealed.signature)}`
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
      return `${toHex(sealed.digest)} ${toHex(sha256(opened))}`
    },
    `${FROZEN.streamBigDigest} ${toHex(sha256(big))}`
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
 * `vectors ok`, or the first that did not match. A core that throws while
 * the fixed inputs are being made is a failure too, never a crash.
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
