import { expect } from 'chai'
import { describe, it } from 'mocha'

import { scriptLiteral } from './pageScript'

describe('scriptLiteral', function () {
  it('writes a value as JSON, its script-ending and line-ending characters escaped', function () {
    const value = '</script> a\u2028b\u2029c [data-x="1"]'
    const literal = scriptLiteral(value)
    expect(literal).not.match(/[<>/\u2028\u2029]/)
    expect(JSON.parse(literal)).equals(value)
    expect(scriptLiteral({ a: [1, '>'] })).equals('{"a":[1,"\\u003e"]}')
  })
})
