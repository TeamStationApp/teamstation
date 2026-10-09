import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import {
  buildFailureReason,
  BuildValidationFailure,
  type ValidationCheck
} from './failure'

describe('safe build failure reasons', () => {
  it('reports a public source location without the message or absolute path', () => {
    const error = new Error('fixture-private-value')
    error.stack =
      'Error: fixture-private-value\n    at fn (/example/scripts/deploy/sentry.ts:164:3)'
    assert.equal(
      buildFailureReason(error),
      'Unexpected build validation error; private details withheld; source: scripts/deploy/sentry.ts:164'
    )
  })
  it('does not mistake an injected frame in the private message for a real frame', () => {
    const error = new Error(
      'fixture-private-value\n    at fn (/example/scripts/deploy/sentry.ts:123:3)'
    )
    error.stack = `Error: ${error.message}\n    at fn (/example/unrecognized.ts:1:1)`
    assert.equal(
      buildFailureReason(error),
      'Unexpected build validation error; private details withheld'
    )
  })
  it('reports only named validation checks without actual metadata', () => {
    const error = new BuildValidationFailure(
      'Apple package metadata did not match',
      ['build-number', 'fixture-private-value' as ValidationCheck]
    )
    assert.equal(
      buildFailureReason(error),
      'Apple package metadata did not match; failed checks: build-number'
    )
  })
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
