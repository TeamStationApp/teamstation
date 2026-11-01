const { test } = require('node:test')
const { strict: assert } = require('node:assert')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const { createCoverageMap } = require('istanbul-lib-coverage')

test('browser coverage cannot change the separate unit-only snapshot', () => {
  const source = readFileSync('scripts/tv-coverage.mjs', 'utf8')
  const snapshot = source.slice(
    source.indexOf('const unitMap ='),
    source.indexOf('if (process.env.TS_TV_BROWSER_COVERAGE')
  )
  const file = hits => ({
    path: '/fixture.js',
    statementMap: {
      0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
      1: { start: { line: 2, column: 0 }, end: { line: 2, column: 1 } }
    },
    fnMap: {},
    branchMap: {},
    s: hits,
    f: {},
    b: {}
  })
  const map = createCoverageMap({ '/fixture.js': file({ 0: 1, 1: 0 }) })
  const unit = vm.runInNewContext(snapshot + '\nunitMap', { map, require })
  map.merge({ '/fixture.js': file({ 0: 0, 1: 1 }) })
  assert.equal(unit.getCoverageSummary().lines.pct, 50)
  assert.equal(map.getCoverageSummary().lines.pct, 100)
})
