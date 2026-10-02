import { expect } from 'chai'
import { describe, it } from 'mocha'
import { types } from 'pg'

import { attachInt8Parser } from './int8'

describe('attachInt8Parser', function () {
  it('reads a safe bigint as a number and throws past that', function () {
    attachInt8Parser()
    const parse = types.getTypeParser(20) as (value: string) => number
    expect(parse('5187822249608915')).equals(5187822249608915)
    expect(() => parse('9007199254740993')).throws(/safe integer/)
  })
})
