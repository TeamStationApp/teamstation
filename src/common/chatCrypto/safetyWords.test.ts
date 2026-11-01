import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo } from '../userId'
import frozen from './frozenVectors.json'
import {
  safetyWordHalf,
  safetyWords,
  safetyWordsFromBytes
} from './safetyNumber'
import { SAFETY_WORDS } from './safetyWordList'

describe('chat safety words', () => {
  const a = {
    userId: userIdOfGumbo(7),
    identityKey: new Uint8Array(32).fill(1)
  }
  const b = {
    userId: userIdOfGumbo(42),
    identityKey: new Uint8Array(32).fill(2)
  }

  it('matches the frozen independent SHA-512 and 11-bit encoding vector', () => {
    expect(safetyWords(a, b)).equals(frozen.frozen.safetyWords)
    expect(safetyWords(b, a)).equals(frozen.frozen.safetyWords)
    expect(safetyWords(a, b).split(' ')).length(16)
    expect(safetyWordHalf(a)).deep.equals(
      frozen.frozen.safetyWords.split(' ').slice(0, 8)
    )
  })

  it('changes only the reset identity half', () => {
    const reset = { ...a, identityKey: new Uint8Array(32).fill(3) }
    const before = safetyWords(a, b).split(' ')
    const after = safetyWords(reset, b).split(' ')
    expect(after.slice(0, 8)).not.deep.equals(before.slice(0, 8))
    expect(after.slice(8)).deep.equals(before.slice(8))
  })

  it('uses the complete canonical BIP-39 list in index order', () => {
    expect(SAFETY_WORDS).length(2048)
    expect(new Set(SAFETY_WORDS).size).equals(2048)
    expect(SAFETY_WORDS[0]).equals('abandon')
    expect(SAFETY_WORDS[2047]).equals('zoo')
    expect(SAFETY_WORDS).deep.equals([...SAFETY_WORDS].sort())
    expect(safetyWordsFromBytes(new Uint8Array(11))).deep.equals(
      Array(8).fill('abandon')
    )
    expect(safetyWordsFromBytes(new Uint8Array(11).fill(255))).deep.equals(
      Array(8).fill('zoo')
    )
    expect(() => safetyWordsFromBytes(new Uint8Array(10))).throws(
      'Expected 88 safety bits'
    )
  })
})
