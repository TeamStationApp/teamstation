import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { buildFailureReason } from './failure'

describe('safe build failure reasons', () => {
  it('reports fixed package and symbol validation failures', () => {
    for (const reason of [
      'Apple package metadata did not match',
      'Sentry upload failed: no bundle or source map'
    ])
      assert.equal(buildFailureReason(new Error(reason)), reason)
  })
  it('reports only known system error codes, excluding paths and messages', () => {
    assert.equal(
      buildFailureReason(
        Object.assign(new Error('private file contents'), {
          code: 'ENOENT',
          path: 'private-path'
        })
      ),
      'Build filesystem operation failed (ENOENT)'
    )
    assert.equal(
      buildFailureReason({ code: 'private-token' }),
      'Unexpected build validation error; private details withheld'
    )
  })
  it('withholds arbitrary error messages, stacks, objects and thrown strings', () => {
    for (const error of [
      new Error('fixture-password'),
      { token: 'fixture-token' },
      'fixture-pin',
      new SyntaxError('private JSON contents')
    ])
      assert.equal(
        buildFailureReason(error),
        'Unexpected build validation error; private details withheld'
      )
  })
})
