import { expect } from 'chai'
import { describe, it } from 'mocha'

import { fonts } from '../theme/fonts'
import { dashboardTheme } from './dashboardTheme'

describe('the scoreboard dashboard’s theme', function () {
  it('letters the board in the carried Inter, never a system font', function () {
    expect(dashboardTheme.secondaryTextFont).equals(fonts.inter)
  })
})
