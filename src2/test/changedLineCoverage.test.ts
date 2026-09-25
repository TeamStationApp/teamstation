import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  changedLines,
  lineReport
} = require('../../scripts/changed-line-coverage.cjs')
describe('changed executable line coverage gate', function () {
  it('selects hunk lines and excludes deleted-only hunks', function () {
    const rows = changedLines(
      '+++ b/a.ts\n@@ -1,2 +1,0 @@\n@@ -4 +3,2 @@\n+++ b/b.ts\n@@ -0,0 +1 @@'
    )
    expect([...rows['a.ts']]).deep.equals([3, 4])
    expect([...rows['b.ts']]).deep.equals([1])
  })
  it('gates uncovered and unmapped executable code and accepts covered/type-only code', function () {
    const changes = {
      'a.ts': new Set([1, 2, 3]),
      'new.ts': new Set([1]),
      'deleted.ts': new Set()
    }
    const coverage = {
      'a.ts': {
        statementMap: { a: { start: { line: 1 }, end: { line: 2 } } },
        s: { a: 1 }
      }
    }
    expect(lineReport(changes, coverage, () => true).pass).equals(false)
    const report = lineReport(changes, coverage, () => false)
    expect(report).includes({ covered: 2, total: 2, percent: 100, pass: true })
    coverage['a.ts'].s.a = 0
    expect(lineReport(changes, coverage, () => false).pass).equals(false)
  })
})
