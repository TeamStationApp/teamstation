import { createHash } from 'node:crypto'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { seed } from '../../test/chatCryptoOracle'
import { userIdOfGumbo, valueOfUserId } from '../userId'
import { deriveKeyPair } from './hpke'
import { signingPublicKey } from './keys'
import { linkCode } from './linkCode'
import { safetyHalf, safetyNumber, safetyNumberGroups } from './safetyNumber'

const alice = {
  userId: userIdOfGumbo(42),
  identityKey: signingPublicKey(seed('identity'))
}
const bob = {
  userId: userIdOfGumbo(7),
  identityKey: signingPublicKey(seed('identity 7'))
}
const SAFETY = '420693152042024233918378460099523999522228652791089056264003'

/** The same digits, the long way, with Node's SHA-512. */
function nodeHalf(party: { userId: string; identityKey: Uint8Array }): string {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(party.identityKey.length)
  const id = Buffer.alloc(8)
  id.writeBigUInt64BE(valueOfUserId(party.userId))
  let hash: Buffer = Buffer.concat([
    Buffer.of(0),
    length,
    Buffer.from(party.identityKey),
    id
  ])
  for (let i = 0; i < 5200; i++)
    hash = createHash('sha512').update(hash).digest()
  let digits = ''
  for (let group = 0; group < 6; group++) {
    const value = hash.readUIntBE(group * 5, 5)
    digits += String(value % 100000).padStart(5, '0')
  }
  return digits
}

describe('chatCrypto safetyNumber', () => {
  it('frozen vector, the same from both sides', () => {
    expect(safetyNumber(alice, bob)).equals(SAFETY)
    expect(safetyNumber(bob, alice)).equals(SAFETY)
    expect(SAFETY).match(/^\d{60}$/)
  })

  it('is SHA-512 5,200 times over 0x00 ‖ lp(key) ‖ u64(userId), lower user id first', () => {
    expect(safetyHalf(bob)).equals(nodeHalf(bob))
    expect(safetyHalf(alice)).equals(nodeHalf(alice))
    expect(SAFETY).equals(nodeHalf(bob) + nodeHalf(alice))
  })

  it('changes when an identity key changes', () => {
    const reset = { ...bob, identityKey: signingPublicKey(seed('identity 7b')) }
    expect(safetyNumber(alice, reset)).not.equals(SAFETY)
    expect(safetyNumber(alice, reset).slice(30)).equals(SAFETY.slice(30))
  })

  it('reads as 12 groups of five', () => {
    const groups = safetyNumberGroups(SAFETY)
    expect(groups).length(12)
    expect(groups[0]).equals('42069')
    expect(groups.join('')).equals(SAFETY)
    expect(safetyNumberGroups('')).deep.equals([])
  })
})

describe('chatCrypto linkCode', () => {
  const publicKey = deriveKeyPair(seed('recipient')).publicKey

  it('frozen vector', () => {
    expect(linkCode(publicKey, 'clk_link1')).equals('134232')
  })

  it('is the first 8 bytes of SHA-256(lp(key) ‖ lp(linkId)) mod 10^6, by Node', () => {
    const length = (n: number): Buffer => {
      const out = Buffer.alloc(4)
      out.writeUInt32BE(n)
      return out
    }
    const hash = createHash('sha256')
      .update(
        Buffer.concat([
          length(32),
          Buffer.from(publicKey),
          length(9),
          Buffer.from('clk_link1')
        ])
      )
      .digest()
    const expected = String(hash.readBigUInt64BE(0) % 1000000n).padStart(6, '0')
    expect(linkCode(publicKey, 'clk_link1')).equals(expected)
  })

  it('is always six digits and differs by link and key', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const code = linkCode(publicKey, `clk_${i}`)
      expect(code).match(/^\d{6}$/)
      codes.add(code)
    }
    expect(codes.size).greaterThan(45)
    expect(linkCode(seed('another key'), 'clk_link1')).not.equals('134232')
  })
})
