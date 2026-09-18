import { expect } from 'chai'
import { describe, it } from 'mocha'

import { actionFor } from './duplicatePeople'

describe('two rows for one child', function () {
  it('does not keep a row with nothing on it', function () {
    expect(actionFor(0, 120)).equals('drop')
    expect(actionFor(120, 0)).equals('drop')
  })

  it('merges when both have a history', function () {
    expect(actionFor(13, 101)).equals('merge')
    expect(actionFor(1, 1)).equals('merge')
  })

  it('drops rather than merges when neither has anything', function () {
    expect(actionFor(0, 0)).equals('drop')
  })
})
