import { expect } from 'chai'
import { describe, it } from 'mocha'

import { playableHere } from './playable.native'

describe('a phone and the video (U33d)', function () {
  it('plays it', function () {
    expect(playableHere()).equals(true)
  })
})
