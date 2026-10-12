'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { newestProgram } = require('./verifyProgram')

describe('newestProgram', () => {
  it('picks a resumed take’s later part over the part one it continues', () => {
    assert.equal(
      newestProgram([ 'program-20261012-160501-2.mp4', 'program-20261012-160501.mp4' ]),
      'program-20261012-160501-2.mp4'
    )
  })

  it('picks the latest stamp, then the highest part', () => {
    assert.equal(
      newestProgram([
        'program-20261012-170000.mp4',
        'program-20261011-090000-3.mp4',
        'program-20261012-170000-10.mp4',
        'program-20261012-170000-2.mp4'
      ]),
      'program-20261012-170000-10.mp4'
    )
  })

  it('puts names it cannot read first', () => {
    assert.equal(newestProgram([ 'program-20261012-170000.mp4', 'odd.mp4' ]), 'program-20261012-170000.mp4')
  })
})
