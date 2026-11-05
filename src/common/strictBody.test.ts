import { expect } from 'chai'
import { describe, it } from 'mocha'

import { strictBody } from './strictBody'

describe('a strict request body', function () {
  const read = (raw: unknown): Record<string, unknown> =>
    strictBody(raw, ['a', 'b'], '{ a, b }', 'Only an a and a b')

  it('takes an object with only the listed keys, or fewer', function () {
    expect(read({ a: 1, b: 2 })).deep.equals({ a: 1, b: 2 })
    expect(read({})).deep.equals({})
  })

  it('refuses anything that is not an object, and names extra keys', function () {
    for (const raw of [null, undefined, [], 'a', 3])
      expect(() => read(raw), String(raw)).throws(
        TypeError,
        'Expected { a, b }'
      )
    expect(() => read({ a: 1, c: 2, d: 3 })).throws(
      TypeError,
      'Only an a and a b, not c, d'
    )
  })
})
