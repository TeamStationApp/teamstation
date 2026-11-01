import { join, lp, u64, utf8 } from './bytes'
import { call } from './core'
import { type CoreCall, flag, num, readFlag, readNumber } from './coreCall'
import vectorFile from './frozenVectors.json'
import { runIdentityVectors } from './identityVectors'
import { openAttachmentWith, sealAttachmentWith } from './stream'
import { fromHex, toHex } from './vectors'

/**
 * Every frozen vector, straight through this platform's chat crypto core
 * (`call`), with the fixed inputs `vectors.ts` and the crate's tests use:
 * `seed(label)` is SHA-256 of the label. Core and WASM tests use these
 * direct calls; the phone, web and Node benches use `vectors.ts` through
 * the same TypeScript wrappers as chat.
 */

export interface CoreVectorResult {
  name: string
  ok: boolean
  got: string
  want: string
}

export function runCoreVectors(core: CoreCall = call): CoreVectorResult[] {
  const results: CoreVectorResult[] = []
  const check = (name: string, got: () => string, want: string): void => {
    let value: string
    try {
      value = got()
    } catch (caught: unknown) {
      value = `threw ${caught instanceof Error ? caught.message : String(caught)}`
    }
    results.push({ name, ok: value === want, got: value, want })
  }
  const one = (op: Parameters<CoreCall>[0], args: Uint8Array[]): Uint8Array =>
    core(op, args)[0]
  const seed = (label: string): Uint8Array => one('sha256', [utf8(label)])
  const rfc = vectorFile.rfc9180A21
  const frozen = vectorFile.frozen
  const empty = new Uint8Array(0)

  check(
    'bucket 541',
    () => String(readNumber(one('bucketSize', [num(541)]))),
    '569'
  )
  check(
    'bucket 20 MiB',
    () => String(readNumber(one('bucketSize', [num(20971520)]))),
    '21453467'
  )

  // RFC 9180 A.2.1, the key schedule included.
  check(
    'RFC 9180 DeriveKeyPair',
    () => toHex(core('deriveKeyPair', [fromHex(rfc.ikmE)])[1]),
    rfc.pkEm
  )
  check(
    'RFC 9180 sequence',
    () =>
      core('hpkeVectorSequence', [
        fromHex(rfc.pkRm),
        fromHex(rfc.skRm),
        fromHex(rfc.info),
        fromHex(rfc.ikmE),
        fromHex(rfc.aad0),
        fromHex(rfc.pt),
        empty,
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

  // HPKE, each purpose with its AAD.
  const [recipientSecret, recipientPublic] = core('deriveKeyPair', [
    seed('recipient')
  ])
  check(
    'recipient key',
    () => toHex(recipientPublic),
    frozen.recipientPublicKey
  )
  const epochAad = join(lp('cnv_c1'), u64(7), u64(42), lp('cid_1'), u64(3))
  const aads = {
    link: join(lp('clk_link1'), lp('cdv_dev2')),
    puk: join(u64(42), lp('cid_1'), u64(3), lp('cdv_dev2')),
    epoch: epochAad,
    grant: epochAad
  }
  const epochKey = seed('epoch key')
  for (const purpose of ['link', 'puk', 'epoch', 'grant'] as const) {
    check(
      `HPKE ${purpose}`,
      () =>
        toHex(
          one('hpkeSeal', [
            utf8(purpose),
            recipientPublic,
            aads[purpose],
            epochKey,
            seed('ephemeral')
          ])
        ),
      frozen.boxes[purpose]
    )
    check(
      `HPKE ${purpose} open`,
      () =>
        toHex(
          one('hpkeOpen', [
            utf8(purpose),
            recipientSecret,
            aads[purpose],
            fromHex(frozen.boxes[purpose])
          ])
        ),
      toHex(epochKey)
    )
  }

  // Messages.
  const identity = seed('identity')
  const identityKey = one('signingPublicKey', [identity])
  check('identity key', () => toHex(identityKey), frozen.identityPublicKey)
  const fields = [
    utf8('cnv_c1'),
    num(7),
    utf8('msg_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
    num(42),
    utf8('post')
  ]
  const messageKey = one('messageKey', [
    epochKey,
    utf8('cnv_c1'),
    utf8('msg_aaaaaaaaaaaaaaaaaaaaaaaaaa')
  ])
  check('message key', () => toHex(messageKey), frozen.messageKey)
  const plaintext = utf8(
    '{"type":"text","body":"hi 🎉","mentions":[],"attachments":[]}'
  )
  const nonce = seed('nonce').subarray(0, 24)
  const sealed = core('sealMessage', [
    ...fields,
    epochKey,
    plaintext,
    identity,
    nonce
  ])
  check(
    'seal',
    () => `${toHex(one('sha256', [sealed[1]]))} ${toHex(sealed[2])}`,
    `${frozen.sealCiphertextSha256} ${frozen.sealSignature}`
  )
  check(
    'seal verifies and opens',
    () =>
      `${readFlag(one('verifyMessage', [...fields, sealed[0], sealed[1], sealed[2], identityKey]))} ${toHex(one('openWithMessageKey', [...fields, messageKey, sealed[0], sealed[1]]))}`,
    `true ${toHex(plaintext)}`
  )

  // Attachments.
  const attachmentKey = seed('attachment key')
  const prefix = seed('prefix').subarray(0, 16)
  check(
    'stream small',
    () =>
      toHex(
        sealAttachmentWith(core, utf8('hello attachment'), {
          key: attachmentKey,
          prefix
        }).digest
      ),
    frozen.streamSmallDigest
  )
  const big = new Uint8Array(200000)
  for (let i = 0; i < big.length; i++) big[i] = i % 251
  check(
    'stream several chunks, round trip',
    () => {
      const { blob, digest } = sealAttachmentWith(core, big, {
        key: attachmentKey,
        prefix
      })
      const opened = openAttachmentWith(core, attachmentKey, blob, digest)
      return `${toHex(digest)} ${toHex(one('sha256', [opened]))}`
    },
    `${frozen.streamBigDigest} ${toHex(one('sha256', [big]))}`
  )

  // The epoch chain.
  const epoch8 = seed('epoch 8')
  check(
    'previous_key_box',
    () =>
      toHex(
        one('sealPreviousEpochKey', [
          utf8('cnv_c1'),
          num(8),
          epoch8,
          epochKey,
          nonce
        ])
      ),
    frozen.previousKeyBox
  )
  check(
    'previous_key_box open',
    () =>
      toHex(
        one('openPreviousEpochKey', [
          utf8('cnv_c1'),
          num(8),
          epoch8,
          fromHex(frozen.previousKeyBox)
        ])
      ),
    toHex(epochKey)
  )
  const signEpoch = (epoch: number, box: Uint8Array): Uint8Array =>
    one('sign', [
      one('epochSignedBytes', [utf8('cnv_c1'), num(epoch), box]),
      identity
    ])
  check(
    'epoch signature',
    () => toHex(signEpoch(8, fromHex(frozen.previousKeyBox))),
    frozen.epochSignature
  )
  check(
    'first epoch signature',
    () => toHex(signEpoch(1, empty)),
    frozen.firstEpochSignature
  )

  // The per-user key chain, the older keys laid out oldest first.
  const older = join(u64(1), lp(seed('puk 1')), u64(2), lp(seed('puk 2')))
  check(
    'previous_keys_box',
    () =>
      toHex(
        one('sealPreviousPukKeys', [
          num(42),
          utf8('cid_1'),
          num(3),
          seed('puk 3'),
          older,
          nonce
        ])
      ),
    frozen.previousKeysBox
  )
  check(
    'PUK signature',
    () =>
      toHex(
        one('sign', [join(u64(42), u64(3), lp(recipientPublic)), identity])
      ),
    frozen.pukSignature
  )

  // The membership log.
  check(
    'log hash chain',
    () => {
      const first = one('logRowHash', [
        new Uint8Array(32),
        utf8('cnv_c1'),
        num(1),
        utf8('join'),
        num(42),
        num(0),
        empty,
        num(1790000000000)
      ])
      const second = one('logRowHash', [
        first,
        utf8('cnv_c1'),
        num(2),
        utf8('leave'),
        num(42),
        num(7),
        utf8('notEligible'),
        num(1790000001000)
      ])
      return `${toHex(first)} ${toHex(second)}`
    },
    frozen.logHashes.join(' ')
  )

  // Safety numbers (lower user id first) and link codes.
  check(
    'safety bytes',
    () => toHex(one('safetyBytes', [new Uint8Array(32).fill(1), num(7)])),
    frozen.safetyBytes
  )
  const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes)
  check(
    'safety number',
    () =>
      ascii(
        one('safetyHalf', [
          one('signingPublicKey', [seed('identity 7')]),
          num(7)
        ])
      ) + ascii(one('safetyHalf', [identityKey, num(42)])),
    frozen.safetyNumber
  )
  check(
    'link code',
    () => ascii(one('linkCode', [recipientPublic, utf8('clk_link1')])),
    frozen.linkCode
  )
  check(
    'chunk nonce',
    () => toHex(one('chunkNonce', [prefix, num(3), flag(true)]).subarray(16)),
    '00000000000003' + '01'
  )
  return [...results, ...runIdentityVectors(core)]
}

/** `vectors ok`, or the first that did not match. */
export function coreVectorSummary(results?: CoreVectorResult[]): string {
  let checked: CoreVectorResult[]
  try {
    checked = results ?? runCoreVectors()
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught)
    return `vectors failed: threw ${message}`
  }
  const failed = checked.find(result => !result.ok)
  return failed == null
    ? 'vectors ok'
    : `vectors failed: ${failed.name} (got ${failed.got.slice(0, 40)})`
}
