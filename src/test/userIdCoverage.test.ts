import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  auditCoverage,
  readCounters,
  swiftTestResult
} = require('../../scripts/user-id-coverage.cjs')

describe('user identity combined coverage gate', () => {
  it('retains completed Swift failures without claiming a passing suite', () => {
    expect(
      swiftTestResult('Identity', 0, '✔ Test run with 2 tests passed after 1s.')
    ).deep.equals({ tests: 2, failures: [] })
    expect(
      swiftTestResult(
        'Identity',
        1,
        '✘ Test storage() failed after 0.1s.\n✘ Test run with 2 tests failed after 1s.'
      )
    ).deep.equals({ tests: 2, failures: ['Identity: storage()'] })
    expect(
      swiftTestResult('Identity', 1, '✘ Test run with 2 tests failed after 1s.')
        .failures
    ).deep.equals(['Identity: host test run failed'])
    for (const [status, text] of [
      [1, 'Build failed'],
      [0, 'Test run with 0 tests passed after 1s.'],
      [0, 'Test run with 2 tests failed after 1s.'],
      [1, 'Test run with 2 tests passed after 1s.'],
      [null, 'Test run with 2 tests failed after 1s.'],
      [139, 'Test run with 2 tests failed after 1s.']
    ])
      expect(() => swiftTestResult('Identity', status, text)).throws(
        'did not complete'
      )
  })
  const snapshot = {
    base: 'base',
    head: 'head',
    files: {
      'src/a.ts': { hash: 'a', added: false, lines: [2, 3] },
      'src/b.ts': { hash: 'b', added: true, lines: [2] }
    }
  }
  const report = (counts: object): any => ({
    base: 'base',
    head: 'head',
    tests: 2,
    hashes: { 'src/a.ts': 'a', 'src/b.ts': 'b' },
    counts
  })
  const full = (): any =>
    report({ 'src/a.ts': { 2: 1, 3: 1 }, 'src/b.ts': { 2: 1, 9: 1 } })
  it('unions overlapping measured lines and covers every executable line in a new file', () => {
    const first = report({
      'src/a.ts': { 2: 1, 3: 0 },
      'src/b.ts': { 2: 1, 9: 0 }
    })
    const second = report({
      'src/a.ts': { 2: 0, 3: 2 },
      'src/b.ts': { 2: 1, 9: 1 }
    })
    const result = auditCoverage(snapshot, [first, second])
    expect(result).includes({ pass: true, covered: 4, total: 4, percent: 100 })
    expect(auditCoverage(snapshot, [first]).pass).equals(false)
  })
  it('fails missing instruments, maps, empty suites and stale revisions or source', () => {
    expect(() => auditCoverage(snapshot, [])).throws('No measured')
    expect(() => auditCoverage(snapshot, [report({})])).throws(
      'Missing instrumentation'
    )
    expect(() => auditCoverage(snapshot, [report({ 'src/a.ts': {} })])).throws(
      'source map'
    )
    for (const patch of [
      { tests: 0 },
      { head: 'old' },
      { base: 'other' },
      { hashes: {} }
    ])
      expect(() => auditCoverage(snapshot, [{ ...full(), ...patch }])).throws()
    expect(() =>
      auditCoverage(snapshot, [report({ 'src/a.ts': { 2: -1 } })])
    ).throws('counter')
    expect(() =>
      auditCoverage(snapshot, [report({ 'src/a.ts': { 0: 1 } })])
    ).throws('counter')
  })
  it('applies the gate per file, including small files even when the aggregate passes', () => {
    const large = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [i + 1, 1])
    )
    const scope = {
      ...snapshot,
      files: {
        'src/a.ts': { hash: 'a', added: true, lines: [] },
        'src/b.ts': { hash: 'b', added: true, lines: [] }
      }
    }
    const result = auditCoverage(scope, [
      report({ 'src/a.ts': large, 'src/b.ts': { 1: 0 } })
    ])
    expect(result.percent).greaterThan(95)
    expect(result.pass).equals(false)
    expect(result.files['src/b.ts'].uncovered).deep.equals([1])
    expect(() => auditCoverage({ ...scope, files: {} }, [full()])).throws(
      'Empty executable'
    )
  })
  it('reads original-source Istanbul, LLVM LCOV and JVM JaCoCo counters', () => {
    expect(
      readCounters(
        'istanbul',
        JSON.stringify({
          'src/a.ts': {
            statementMap: { 0: { start: { line: 2 }, end: { line: 2 } } },
            s: { 0: 3 }
          }
        })
      )
    ).deep.equals({ 'src/a.ts': { 2: 3 } })
    expect(
      readCounters('lcov', 'SF:src/a.swift\nDA:2,3\nend_of_record')
    ).deep.equals({ 'src/a.swift': { 2: 3 } })
    expect(
      readCounters(
        'jacoco',
        '<package name="app"><sourcefile name="A.kt"><line nr="2" ci="3"/></sourcefile></package>'
      )
    ).deep.equals({ 'app/A.kt': { 2: 3 } })
    expect(() => readCounters('unknown', '')).throws('Unknown coverage')
  })
})
