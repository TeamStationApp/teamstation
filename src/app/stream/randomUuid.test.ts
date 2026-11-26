import { expect } from 'chai'
import { describe, it } from 'mocha'

import * as deviceId from './deviceId'
import { randomUuid } from './randomUuid'

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomUuid', () => {
  it('gives a version 4 UUID', () => {
    const first = randomUuid()
    expect(first).matches(V4)
    expect(randomUuid()).not.equals(first)
    expect(randomUuid(bytes => bytes.fill(0xff))).equals(
      'ffffffff-ffff-4fff-bfff-ffffffffffff'
    )
  })
  it('makes one without crypto, from Math.random', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined
    })
    try {
      expect(randomUuid()).matches(V4)
    } finally {
      if (saved != null) Object.defineProperty(globalThis, 'crypto', saved)
    }
  })
  it('is the function deviceId.ts re-exports', () => {
    expect(deviceId.randomUuid).equals(randomUuid)
  })
})
