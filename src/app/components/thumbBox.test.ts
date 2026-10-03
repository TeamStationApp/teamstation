import { expect } from 'chai'
import { describe, it } from 'mocha'

import { thumbBox } from './thumbBox'

describe('thumbBox', function () {
  it('keeps today’s 16:9 width and grows to 4:3', function () {
    const textHeight = 48
    const box = thumbBox(textHeight)
    expect(box.width).equals((textHeight * 16) / 9)
    expect(box.height).equals((box.width * 3) / 4)
    expect(box.height).greaterThan(textHeight)
  })
})
