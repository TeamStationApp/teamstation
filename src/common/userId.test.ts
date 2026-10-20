import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGumboId,
  asUserId,
  gumboOfUserId,
  userIdOfGumbo,
  userIdOfValue
} from './userId'
import vectors from './userId.vectors.json'

describe('canonical user ids', function () {
  it('encodes every shared vector and reads its gumbo id only in the old range', function () {
    for (const { value, userId } of vectors.accepted) {
      expect(userIdOfValue(BigInt(value))).equals(userId)
      expect(asUserId(userId)).equals(userId)
      const gumbo = BigInt(value) < 1n << 53n ? Number(value) : null
      expect(gumboOfUserId(userId)).equals(gumbo)
      if (gumbo != null) expect(userIdOfGumbo(gumbo)).equals(userId)
    }
    expect(userIdOfGumbo(1)).equals('usr_' + '1'.repeat(21) + '2')
  })

  it('rejects every shared invalid spelling without coercion', function () {
    for (const value of vectors.rejected) {
      expect(() => asUserId(value), JSON.stringify(value)).throws(TypeError)
    }
    for (const value of [null, undefined, 1, {}, [], true]) {
      expect(() => asUserId(value)).throws(TypeError)
    }
    expect(() => gumboOfUserId('1')).throws(TypeError)
  })

  it('rejects invalid values before encoding', function () {
    for (const value of [0n, -1n, 1n << 128n]) {
      expect(() => userIdOfValue(value)).throws(TypeError)
    }
    expect(() => userIdOfValue(1 as unknown as bigint)).throws(TypeError)
  })

  it('accepts only numeric positive safe integers as gumbo ids', function () {
    for (const value of [1, 58, Number.MAX_SAFE_INTEGER]) {
      expect(asGumboId(value)).equals(value)
      expect(gumboOfUserId(userIdOfGumbo(value))).equals(value)
    }
    for (const value of [0, -1, 0.5, 2 ** 53, NaN, Infinity, '1', null, 1n]) {
      expect(() => asGumboId(value)).throws(TypeError)
      expect(() => userIdOfGumbo(value as number)).throws(TypeError)
    }
  })

  it('preserves case as identity data', function () {
    const a = 'usr_' + '1'.repeat(21) + 'a'
    const b = 'usr_' + '1'.repeat(21) + 'A'
    expect(asUserId(a)).not.equals(asUserId(b))
    expect(gumboOfUserId(a)).not.equals(gumboOfUserId(b))
  })
})
