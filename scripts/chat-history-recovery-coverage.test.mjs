import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { mergeRecoveryCoverage } from './chat-history-recovery-coverage.mjs'

const source = { revision: 'synthetic', tree: 'tree', base: 'base' }
const path = '/source/feature.ts'
const report = count => ({
  [path]: {
    path,
    statementMap: {
      0: { start: { line: 1, column: 0 }, end: { line: 1, column: 8 } }
    },
    s: { 0: count },
    fnMap: {},
    f: {},
    branchMap: {},
    b: {}
  }
})
function receipt(data, overrides = {}) {
  const bytes = JSON.stringify(data)
  return [
    {
      source,
      report: 'report',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...overrides
    },
    () => bytes
  ]
}
test('merges actual counters', () => {
  const [r, read] = receipt(report(2))
  assert.equal(mergeRecoveryCoverage([r, r], source, read)[path].s[0], 4)
})
test('rejects absent, stale, corrupted, unmapped and empty reports', () => {
  assert.throws(() => mergeRecoveryCoverage([], source), /No measured/)
  for (const [data, overrides, pattern] of [
    [report(1), { source: { revision: 'old' } }, /Stale/],
    [report(1), { sha256: 'wrong' }, /hash/],
    [{}, {}, /instrumentation/],
    [{ [path]: { path } }, {}, /maps/],
    [{ [path]: { ...report(1)[path], path: '/other.ts' } }, {}, /maps/],
    [
      {
        '/source/lib/bundle.js': {
          ...report(1)[path],
          path: '/source/lib/bundle.js'
        }
      },
      {},
      /remapped/
    ]
  ]) {
    const [r, read] = receipt(data, overrides)
    assert.throws(() => mergeRecoveryCoverage([r], source, read), pattern)
  }
})
