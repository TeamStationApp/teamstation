import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  addonPath,
  call,
  chatCoreStatus,
  loadAddon,
  loadChatCore
} from './core'
import {
  ChatCryptoError,
  ChatCryptoUnavailable,
  decodeResults,
  encodeArgs,
  makeCall,
  num,
  readFlag,
  readNumber,
  selfTest
} from './coreCall'
import { coreVectorSummary, runCoreVectors } from './coreVectors'

/** The chat crypto core in Node: the addon, and the wire every platform shares. */
describe('chat crypto core in Node', () => {
  it('is ready, and gives every frozen vector', async () => {
    expect(chatCoreStatus()).deep.equals({ ready: true })
    expect(await loadChatCore()).deep.equals({ ready: true })
    const results = runCoreVectors()
    expect(results.filter(result => !result.ok)).deep.equals([])
    expect(coreVectorSummary(results)).equals('vectors ok')
    expect(selfTest(call)).equals(true)
  })

  it('round-trips arguments and results', () => {
    const [digest] = call('sha256', [Uint8Array.of(0x61, 0x62, 0x63)])
    expect(Buffer.from(digest).toString('hex')).equals(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(readNumber(call('bucketSize', [num(541)])[0])).equals(569)
    const [secret, pub] = call('newSigningKeyPair', [])
    const [signature] = call('sign', [Uint8Array.of(1), secret])
    expect(
      readFlag(call('verify', [signature, Uint8Array.of(1), pub])[0])
    ).equals(true)
    expect(
      readFlag(call('verify', [signature, Uint8Array.of(2), pub])[0])
    ).equals(false)
  })

  it('throws the core’s refusal by name', () => {
    expect(() =>
      call('hpkeOpen', [
        Uint8Array.of(1),
        new Uint8Array(32),
        new Uint8Array(0),
        new Uint8Array(48)
      ])
    )
      .throws(ChatCryptoError)
      .with.property('reason', 'malformed')
    expect(() => call('sha256', [])).throws(ChatCryptoError, 'malformed')
    expect(() => call('bucketSize', [num(Number.MAX_SAFE_INTEGER)]))
      .throws(ChatCryptoError)
      .with.property('reason', 'tooLarge')
  })

  it('reads the wire strictly', () => {
    expect(encodeArgs([Uint8Array.of(9), new Uint8Array(0)])).deep.equals(
      Uint8Array.of(0, 0, 0, 1, 9, 0, 0, 0, 0)
    )
    expect(decodeResults(Uint8Array.of(0, 0, 0, 0, 1, 7))).deep.equals([
      Uint8Array.of(7)
    ])
    expect(decodeResults(Uint8Array.of(0))).deep.equals([])
    expect(() => decodeResults(new Uint8Array(0))).throws(ChatCryptoError)
    expect(() => decodeResults(Uint8Array.of(0, 0, 0))).throws(ChatCryptoError)
    expect(() => decodeResults(Uint8Array.of(0, 0, 0, 0, 5, 1))).throws(
      ChatCryptoError
    )
    // A status that is neither an answer nor a refusal is not read as one.
    expect(() => decodeResults(Uint8Array.of(2, 0, 0, 0, 0))).throws(
      'malformed'
    )
    const unknown = new ChatCryptoError('somethingNew')
    expect(unknown.reason).equals('unknown')
    expect(() => readNumber(Uint8Array.of(1))).throws(ChatCryptoError)
    expect(new ChatCryptoUnavailable('noNativeModule').reason).equals(
      'noNativeModule'
    )
  })

  it('a self-test fails on a core that computes other bytes', () => {
    const wrong = makeCall((_op, _input) =>
      Uint8Array.of(0, 0, 0, 0, 32, ...new Uint8Array(32))
    )
    expect(selfTest(wrong)).equals(false)
    const throwing = makeCall(() => {
      throw new Error('broken')
    })
    expect(selfTest(throwing)).equals(false)
  })

  it('says how to build a missing addon', () => {
    expect(addonPath()).match(/chatCrypto[/\\]node[/\\]chat_crypto\.node$/)
    expect(() =>
      loadAddon('/nowhere/chat_crypto.node', () => {
        throw new Error('not found')
      })
    ).throws('run npm run chat-crypto')
    expect(() =>
      loadAddon('/nowhere/x.node', () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'odd'
      })
    ).throws('odd')
  })
})
