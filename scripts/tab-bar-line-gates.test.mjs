import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, it } from 'mocha'

import lines from './changed-line-coverage.cjs'
import {
  coverageGates,
  jsCounts,
  measured,
  verifyNodeSources
} from './tab-bar-line-gates.mjs'

const source = 'current revision'
const hundred = Array.from({ length: 100 }, (_, index) => index + 1)
const counters = predicate =>
  Object.fromEntries(hundred.map(line => [line, Number(predicate(line))]))

describe('tab-bar unit and combined coverage', () => {
  it('requires compiled JS measurements to map to the tested source bytes', () => {
    const file = 'src/app/components/tabBarModel.ts'
    const values = { [file]: { 1: 1 } }
    const url = pathToFileURL(resolve('lib/bundle.js')).href
    const record = contents => ({
      result: [{ url }],
      'source-map-cache': {
        [url]: {
          data: {
            sources: [pathToFileURL(resolve(file)).href],
            sourcesContent: [contents]
          }
        }
      }
    })
    verifyNodeSources(values, [record(readFileSync(file, 'utf8'))])
    assert.throws(
      () => verifyNodeSources(values, [record('previous source')]),
      /Stale/
    )
    assert.throws(() => verifyNodeSources(values, []), /Unverified V8 source/)
  })
  for (const [kind, file] of [
    ['js', 'src/app/App.tsx'],
    ['native', 'ios/TeamStation/TSTabBarComponentView.mm']
  ]) {
    it(
      'accepts 92% unit and 98% combined measured ' + kind + ' coverage',
      () => {
        const unit = { [file]: counters(line => line <= 92) }
        const supplemental = measured(kind, source, {
          [file]: counters(line => line >= 92 && line <= 98)
        })
        const reports = coverageGates(kind, source, unit, [supplemental]).map(
          ([min, counts]) =>
            lines.lineReportFromCounts(
              { [file]: new Set(hundred) },
              counts,
              () => true,
              { min, perFileMin: min, newFileMin: min, newFiles: [file] }
            )
        )
        assert.deepEqual(
          reports.map(row => [row.percent, row.pass]),
          [
            [92, true],
            [98, true]
          ]
        )
        assert.equal(
          unit[file][92],
          1,
          'the combined measurement leaves unit counters intact'
        )
        assert.equal(
          coverageGates(kind, source, unit, [supplemental])[1][1][file][92],
          2
        )
      }
    )
    it(
      'keeps per-file failures visible even with a passing ' + kind + ' total',
      () => {
        const unit = {
          [file]: counters(line => line <= 89),
          other: counters(() => true)
        }
        const supplement = measured(kind, source, {
          [file]: counters(line => line <= 94)
        })
        for (const [min, counts] of coverageGates(kind, source, unit, [
          supplement
        ])) {
          const report = lines.lineReportFromCounts(
            { [file]: new Set(hundred), other: new Set(hundred) },
            counts,
            () => true,
            { min, perFileMin: min }
          )
          assert.ok(report.percent >= min)
          assert.deepEqual(report.shortFiles, [file])
          assert.equal(report.pass, false)
        }
      }
    )
  }
  it('rejects stale, unversioned and empty evidence', () => {
    const unit = { 'src/app/App.tsx': { 3: 1 } }
    for (const receipt of [measured('js', 'previous revision', unit), unit])
      assert.throws(
        () => coverageGates('js', source, unit, [receipt]),
        /different source revision or format/
      )
    assert.throws(() => measured('native', source, {}), /No measured/)
    assert.throws(
      () => measured('js', source, { 'src/app/App.tsx': { 3: -1 } }),
      /Invalid measured/
    )
    assert.deepEqual(coverageGates('js', source, unit, []), [
      [90, unit],
      [95, unit]
    ])
  })
  it('preserves unmapped and uncovered lines when normalizing a source-mapped JS report', () => {
    const file = '/checkout/src/app/App.tsx'
    const entry = {
      statementMap: {
        0: { start: { line: 2 }, end: { line: 3 } },
        1: { start: { line: 6 }, end: { line: 6 } }
      },
      s: { 0: 1, 1: 0 }
    }
    assert.deepEqual(
      jsCounts(
        { [file]: entry, '/checkout/node_modules/vendor.js': entry },
        '/checkout'
      ),
      { 'src/app/App.tsx': { 2: 1, 3: 1, 6: 0 } }
    )
  })
})
