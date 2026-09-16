import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  bearerToken,
  hashToken,
  makeEmailCode,
  makeToken,
  tokensMatch
} from './tokens'

describe('tokens', function () {
  it('makes tokens that do not repeat', function () {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(makeToken())
    expect(seen.size).equals(500)
  })

  it('makes tokens that are safe in a header and a URL', function () {
    for (let i = 0; i < 50; i++) {
      const token = makeToken()
      expect(encodeURIComponent(token)).equals(token)
      expect(bearerToken(`Bearer ${token}`)).equals(token)
    }
  })

  it('hashes to a stable hex digest', function () {
    const token = makeToken()
    expect(hashToken(token)).equals(hashToken(token))
    expect(hashToken(token)).match(/^[0-9a-f]{64}$/)
  })

  it('does not reveal the token in its hash', function () {
    const token = makeToken()
    expect(hashToken(token)).does.not.contain(token)
  })

  it('matches equal digests and rejects different ones', function () {
    const a = hashToken('one')
    const b = hashToken('two')
    expect(tokensMatch(a, a)).equals(true)
    expect(tokensMatch(a, b)).equals(false)
  })

  it('rejects an empty or ragged digest rather than throwing', function () {
    expect(tokensMatch('', '')).equals(false)
    expect(tokensMatch('abcd', 'ab')).equals(false)
  })

  it('reads only a well-formed bearer header', function () {
    expect(bearerToken(undefined)).equals(undefined)
    expect(bearerToken('')).equals(undefined)
    expect(bearerToken('Basic abc')).equals(undefined)
    expect(bearerToken('Bearer')).equals(undefined)
    expect(bearerToken('Bearer a b')).equals(undefined)
    expect(bearerToken('  Bearer abc123  ')).equals('abc123')
  })

  it('makes six-digit codes across the whole range', function () {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const code = makeEmailCode()
      expect(code).match(/^[0-9]{6}$/)
      seen.add(code)
    }
    // A uniform draw over a million values should rarely repeat in 2000 tries.
    expect(seen.size).is.greaterThan(1900)
  })
})
