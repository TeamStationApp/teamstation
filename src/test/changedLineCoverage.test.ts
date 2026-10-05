import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  changedLines,
  istanbulCounts,
  jacocoCounts,
  lcovCounts,
  lineReport,
  lineReportFromCounts,
  resolveSpecs,
  xccovCounts
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

describe('changed-line counts from every report', function () {
  const fixture = (name: string): string =>
    readFileSync(`src/test/fixtures/coverage/${name}`, 'utf8')

  it('computes the percent, and fails under 90 overall or for a new file alone', function () {
    const changes = {
      'old.ts': new Set(Array.from({ length: 20 }, (_, i) => i + 1)),
      'new.ts': new Set([1, 2, 3, 4])
    }
    const counts: Record<string, Record<number, number>> = {
      'old.ts': Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [i + 1, 1])
      ),
      'new.ts': { 1: 1, 2: 1, 3: 0, 4: 1 }
    }
    const passing = lineReportFromCounts(changes, counts, () => true)
    expect(passing).includes({ covered: 23, total: 24, pass: true })
    expect(passing.percent).closeTo(95.83, 0.01)
    // The same numbers, with new.ts added on this branch: 75% alone fails.
    const added = lineReportFromCounts(changes, counts, () => true, {
      newFiles: ['new.ts']
    })
    expect(added.percent).closeTo(95.83, 0.01)
    expect(added.newFiles).deep.equals({ 'new.ts': 75 })
    expect(added.shortNewFiles).deep.equals(['new.ts'])
    expect(added.pass).equals(false)
    counts['old.ts'] = { 1: 0, 2: 0, 3: 0 }
    const under = lineReportFromCounts(changes, counts, () => true)
    expect(under.percent).closeTo(100 * (3 / 7), 0.01)
    expect(under.pass).equals(false)
  })

  it('lists a changed file with no record as missing, and ignores lines with no code', function () {
    const report = lineReportFromCounts(
      { 'a.ts': new Set([1, 2, 9]), 'b.ts': new Set([1]), 'c.ts': new Set() },
      { 'a.ts': { 1: 3, 2: 0 } },
      (path: string) => path === 'b.ts'
    )
    expect(report.missing).deep.equals(['b.ts'])
    expect(report.files['a.ts']).deep.equals({ covered: [1], uncovered: [2] })
    expect(report).includes({ covered: 1, total: 2, pass: false })
  })

  it('reads Istanbul as lineReport always has', function () {
    const entry = {
      statementMap: {
        a: { start: { line: 1 }, end: { line: 2 } },
        b: { start: { line: 2 }, end: { line: 2 } },
        c: { start: { line: 5 }, end: { line: 5 } }
      },
      s: { a: 0, b: 4, c: 0 }
    }
    expect(istanbulCounts(entry)).deep.equals({ 1: 0, 2: 4, 5: 0 })
    const changes = { 'x.ts': new Set([1, 2, 3, 5]) }
    const byEntry = lineReport(changes, { 'x.ts': entry }, () => true)
    const byCounts = lineReportFromCounts(
      changes,
      { 'x.ts': istanbulCounts(entry) },
      () => true
    )
    expect(byCounts).deep.equals(byEntry)
    expect(byEntry).includes({ covered: 1, total: 3 })
  })

  it('reads a recorded xccov file report and a recorded lcov report', function () {
    const source = '/repo/Tally/Sources/Tally/Tally.swift'
    const executable = {
      2: 1,
      3: 1,
      5: 1,
      6: 1,
      7: 1,
      8: 1,
      9: 0,
      10: 0,
      11: 1
    }
    expect(xccovCounts(JSON.parse(fixture('tally.xccov.json')))).deep.equals({
      [source]: executable
    })
    const lcov = lcovCounts(fixture('tally.lcov'))
    expect(lcov[source]).deep.equals(executable)
    expect(Object.keys(lcov)).has.length(3)
    expect(lcov['/repo/Tally/Tests/TallyTests/TallyTests.swift'][5]).equals(1)
  })

  it('reads a JaCoCo XML report by package directory, a line counting its covered instructions', function () {
    expect(jacocoCounts(fixture('tally.jacoco.xml'))).deep.equals({
      'app/example/tally/Tally.kt': { 5: 3, 6: 4, 7: 0, 9: 2 },
      'app/example/tally/Empty.kt': {},
      'Root.kt': { 1: 5 }
    })
    expect(jacocoCounts('<report></report>')).deep.equals({})
  })

  it('resolves pathspecs to the top level from anywhere inside it', function () {
    const top = '/repo'
    expect(resolveSpecs(top, ['mobile/apps/tsDirector'], top)).deep.equals([
      'mobile/apps/tsDirector'
    ])
    expect(
      resolveSpecs(top, ['.'], `${top}/mobile/apps/tsDirector`)
    ).deep.equals(['mobile/apps/tsDirector'])
    expect(
      resolveSpecs(
        top,
        ['../../common/DirectorCore'],
        `${top}/mobile/apps/tsDirector`
      )
    ).deep.equals(['mobile/common/DirectorCore'])
    expect(resolveSpecs(top, ['.'], top)).deep.equals(['.'])
  })
})
