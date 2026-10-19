import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asUserId, gumboOfUserId, userIdOfValue } from '../../common/userId'
import { mintUserId } from './mintUserId'

describe('mintUserId', function () {
  it('redraws values reserved for existing users, including zero', function () {
    const draws = [0n, (1n << 53n) - 1n, 1n << 53n]
    const result = mintUserId(size => {
      expect(size).equals(16)
      const value = draws.shift()!
      return Buffer.from(value.toString(16).padStart(32, '0'), 'hex')
    })
    expect(result).equals(userIdOfValue(1n << 53n))
    expect(draws).deep.equals([])
  })

  it('encodes all 128 random bits in big-endian order', function () {
    expect(mintUserId(() => new Uint8Array(16).fill(255))).equals(
      userIdOfValue((1n << 128n) - 1n)
    )
    expect(
      mintUserId(() => Uint8Array.from({ length: 16 }, (_, i) => i))
    ).equals(userIdOfValue(0x000102030405060708090a0b0c0d0e0fn))
  })

  it('refuses a malformed entropy source and propagates entropy failures', function () {
    expect(() => mintUserId(() => new Uint8Array(15))).throws('16 random bytes')
    expect(() =>
      mintUserId(() => {
        throw new Error('entropy unavailable')
      })
    ).throws('entropy unavailable')
  })

  it('mints distinct valid identities outside the derived range', function () {
    const ids = new Set<string>()
    for (let i = 0; i < 10000; i++) {
      const id = mintUserId()
      expect(asUserId(id)).equals(id)
      expect(gumboOfUserId(id)).equals(null)
      ids.add(id)
    }
    expect(ids.size).equals(10000)
  })
})
