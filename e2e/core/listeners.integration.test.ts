import { expect } from 'chai'
import { describe, it } from 'mocha'

import { auditListeners } from './listeners'

describe('the listener audit, on this machine', function () {
  it('finds nothing listening under this test process', function () {
    expect(auditListeners()).deep.equals([])
  })
})
