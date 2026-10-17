import { expect } from 'chai'
import { describe, it } from 'mocha'

import { fonts } from '../theme/fonts'
import { scoreboardTheme } from './scoreboardTheme'

describe('the board’s secondary font (U38)', function () {
  it('is Inter, carried by the app, never a system font', function () {
    expect(scoreboardTheme.secondaryTextFont).equals(fonts.inter)
    expect(scoreboardTheme.secondaryTextFont).equals('Inter, sans-serif')
  })
})
