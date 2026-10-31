import { expect } from 'chai'
import { describe, it } from 'mocha'

import { makeInviteCode } from './invites'

describe('makeInviteCode', function () {
  it('writes eight letters from the alphabet that reads aloud', function () {
    for (let i = 0; i < 200; i++) {
      expect(makeInviteCode()).matches(/^[a-hjkmnp-z2-9]{8}$/)
    }
  })
})
