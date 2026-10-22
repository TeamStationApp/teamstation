import { join, lp, u64, utf8 } from './bytes'
import file from './canonicalIdentityVectors.json'
import type { CoreCall } from './coreCall'

/** Shared Node, WASM and native vectors, including the complete 128-bit boundary. */
export function runIdentityVectors(core: CoreCall): Array<{
  name: string
  ok: boolean
  got: string
  want: string
}> {
  const results: ReturnType<typeof runIdentityVectors> = []
  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  const bytes = (text: string): Uint8Array =>
    Uint8Array.from(text.match(/../g) ?? [], pair => parseInt(pair, 16))
  const one = (op: Parameters<CoreCall>[0], args: Uint8Array[]): Uint8Array =>
    core(op, args)[0]
  const seed = (label: string): Uint8Array => one('sha256', [utf8(label)])
  const identity = seed('identity')
  const identityKey = one('signingPublicKey', [identity])
  const epochKey = seed('epoch key')
  const nonce = seed('nonce').subarray(0, 24)
  const plaintext = utf8('authenticated legacy or full-width author')
  for (const row of file.rows) {
    const user = bytes(row.encoded)
    const check = (name: string, run: () => string, want: string): void => {
      let got: string
      try {
        got = run()
      } catch {
        got = 'refused'
      }
      results.push({
        name: `identity ${row.value} ${name}`,
        ok: got === want,
        got,
        want
      })
    }
    const fields = [
      utf8('cnv_identity'),
      u64(1),
      utf8('msg_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
      user,
      utf8('post')
    ]
    check(
      'AAD',
      () =>
        hex(
          join(
            lp('cnv_identity'),
            u64(1),
            lp('msg_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
            user,
            lp('post')
          )
        ),
      row.messageAad
    )
    check(
      'seal',
      () => {
        const sealed = core('sealMessage', [
          ...fields,
          epochKey,
          plaintext,
          identity,
          nonce
        ])
        return `${hex(one('sha256', [sealed[1]]))} ${hex(sealed[2])}`
      },
      `${row.ciphertextSha256} ${row.signature}`
    )
    check(
      'previous PUKs',
      () =>
        hex(
          one('sealPreviousPukKeys', [
            user,
            utf8('cid_identity'),
            u64(3),
            seed('puk 3'),
            join(u64(1), lp(seed('puk 1'))),
            nonce
          ])
        ),
      row.previousKeysBox
    )
    check(
      'PUK signature',
      () => hex(one('sign', [join(user, u64(3), lp(identityKey)), identity])),
      row.pukSignature
    )
    for (const actor of [0, 7]) {
      check(
        `log actor ${actor}`,
        () =>
          hex(
            one('logRowHash', [
              new Uint8Array(32),
              utf8('cnv_identity'),
              u64(1),
              utf8('join'),
              user,
              u64(actor),
              utf8(''),
              u64(1234)
            ])
          ),
        actor === 0 ? row.logNull : row.logMixed
      )
    }
    check(
      'safety half',
      () => String.fromCharCode(...one('safetyHalf', [identityKey, user])),
      row.safetyHalf
    )
  }
  return results
}
