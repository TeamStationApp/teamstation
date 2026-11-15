import { expect } from 'chai'
import { describe, it } from 'mocha'

import { auditListeners } from './listeners'

/** It runs lsof over this process's tree, so it is an integration test. */
describe('the listener audit, on this process', function () {
  it('finds nothing listening under this test process', function () {
    expect(auditListeners()).deep.equals([])
  })
})
