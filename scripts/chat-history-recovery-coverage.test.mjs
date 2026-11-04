import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  mergeRecoveryCoverage,
  normalizeCoverageSources
} from './chat-history-recovery-coverage.mjs'

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
test('normalizes file URLs without changing counters or relative sources', () => {
  const data = {
    result: [{ count: 3 }],
    'source-map-cache': {
      app: { data: { sources: ['file:///source/a%20b.ts', '../other.ts'] } },
      missing: {}
    }
  }
  assert.equal(normalizeCoverageSources(data), data)
  assert.deepEqual(data['source-map-cache'].app.data.sources, [
    '/source/a b.ts',
    '../other.ts'
  ])
  assert.deepEqual(data.result, [{ count: 3 }])
  assert.deepEqual(normalizeCoverageSources({}), {})
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

test('unit and combined gates require the intended suites and provenance', async () => {
  const { main } = await import('./chat-history-recovery-coverage.mjs')
  const runs = []
  const writes = []
  const bytes = JSON.stringify(report(1))
  const receipts = ['unit', 'integration', 'browser'].map(kind => ({
    ...receipt(report(1))[0],
    kind
  }))
  const io = {
    env: { TS_COVERAGE_BASE: 'base', TS_CHAT_RECOVERY_ARTIFACTS: '/artifacts' },
    sourceFor: () => source,
    verifySource: () => {},
    mkdir: () => {},
    glob: () => [],
    read: path =>
      path.endsWith('coverage-receipts.json')
        ? JSON.stringify(receipts)
        : bytes,
    write: (path, content) => writes.push([path, content]),
    run: (command, args) => runs.push([command, args])
  }
  main('unit', io)
  for (const [, args] of runs.filter(
    ([, args]) =>
      args.includes('node_modules/c8/bin/c8.js') && !args.includes('report')
  )) {
    // Otherwise c8 parses mocha's -r as additional report formats.
    assert(args.indexOf('--') > args.indexOf('--exclude-after-remap'))
  }
  assert(
    runs.some(([, args]) =>
      args.includes('src/server/chat/historyPolicy.test.ts')
    )
  )
  assert(
    runs.some(([, args]) =>
      args.includes('scripts/chat-history-recovery-test-bundle.mjs')
    )
  )
  assert.equal(runs.at(-1)[1][runs.at(-1)[1].indexOf('--min') + 1], '90')
  assert(runs.at(-1)[1].includes('src/migrate/migrations'))
  runs.length = 0
  main('combined', io)
  assert.equal(runs.at(-1)[1][runs.at(-1)[1].indexOf('--min') + 1], '95')
  assert(!runs.at(-1)[1].includes('src/migrate/migrations'))
  assert(writes.some(([path]) => path.endsWith('receipt.json')))
  assert.throws(() => main('wrong', io), /Expected unit/)
  assert.throws(() => main('unit', { ...io, env: {} }), /TS_COVERAGE_BASE/)
  assert.throws(
    () => main('combined', { ...io, env: { TS_COVERAGE_BASE: 'base' } }),
    /TS_CHAT_RECOVERY_ARTIFACTS/
  )
  assert.throws(
    () => main('combined', { ...io, read: () => JSON.stringify([]) }),
    /Missing unit/
  )
  assert.throws(
    () =>
      main('combined', {
        ...io,
        verifySource: () => {
          throw new Error('source changed')
        }
      }),
    /source changed/
  )
})
