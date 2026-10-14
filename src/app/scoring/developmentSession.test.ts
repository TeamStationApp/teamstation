import { expect } from 'chai'
import { describe, it } from 'mocha'

import * as common from '../../common/scoring/startingSetup'
import { startingSetup, teamsOf } from './developmentSession'

describe('the starting setup, from the app (U4b)', function () {
  it('is the scoring library’s own', function () {
    expect(startingSetup).equals(common.startingSetup)
    expect(teamsOf).equals(common.teamsOf)
  })
})
