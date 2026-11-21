import { expect } from 'chai'
import { describe, it } from 'mocha'

import { playerDebug } from './debugFlag.native'

describe('?debug=1 on the phone', function () {
  it('is never on: the app has no address to carry it', function () {
    expect(playerDebug()).equals(false)
  })
})
