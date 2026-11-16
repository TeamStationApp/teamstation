import { expect } from 'chai'
import { describe, it } from 'mocha'

import { likeLiteral } from './likeText'

describe('LIKE literals', function () {
  it('escapes the characters LIKE reads, and leaves the rest', function () {
    expect(likeLiteral('50%_off\\now')).equals('50\\%\\_off\\\\now')
    expect(likeLiteral('Babe Ruth')).equals('Babe Ruth')
  })
})
