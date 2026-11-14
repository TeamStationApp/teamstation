import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  coverageArguments,
  evaluate,
  mergeReports
} from './camera-focus-coverage.mjs'

test('merged measured hits cover a line once and retain uncovered lines', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'focus-coverage-'))
  try {
    writeFileSync(path.join(root, 'camera.kt'), 'first()\nsecond()\nthird()\n')
    const unit = path.join(root, 'unit.json')
    const device = path.join(root, 'device.info')
    const source = { revision: 'commit', tree: 'tree', base: 'base' }
    const measured = JSON.stringify({
      source,
      command: ['llvm-cov', 'export'],
      counts: { 'camera.kt': { 1: 4, 2: 0, 3: 0 } }
    })
    writeFileSync(unit, measured)
    writeFileSync(
      device,
      'SF:camera.kt\nDA:1,1\nDA:2,2\nDA:3,0\nend_of_record\n'
    )
    const reports = [
      {
        source,
        kind: 'unit',
        format: 'counts',
        file: unit,
        sourceRoot: root,
        digest: createHash('sha256').update(measured).digest('hex')
      },
      { source, kind: 'device', format: 'lcov', file: device, sourceRoot: root }
    ]
    const merged = mergeReports(source, reports, root)
    assert.deepEqual(merged.counts['camera.kt'], { 1: 5, 2: 2, 3: 0 })
    assert.deepEqual(merged.unit['camera.kt'], { 1: 4, 2: 0, 3: 0 })
    const report = evaluate(
      { 'camera.kt': new Set([1, 2, 3]) },
      merged.counts,
      [],
      95
    )
    assert.equal(report.covered, 2)
    assert.equal(report.total, 3)
    assert.equal(report.pass, false)
    assert.throws(
      () => mergeReports({ ...source, revision: 'other' }, reports, root),
      /revision mismatch/
    )
    assert.throws(
      () =>
        mergeReports(
          source,
          [{ ...reports[0], file: path.join(root, 'missing') }],
          root
        ),
      /ENOENT/
    )
    const invalid = JSON.stringify({
      source,
      command: ['llvm-cov', 'export'],
      counts: { 'camera.kt': { 1: -1 } }
    })
    writeFileSync(unit, invalid)
    assert.throws(
      () => mergeReports(source, [reports[0]], root),
      /changed after measurement/
    )
    reports[0].digest = createHash('sha256').update(invalid).digest('hex')
    assert.throws(
      () => mergeReports(source, [reports[0]], root),
      /Invalid measured counter/
    )
    writeFileSync(unit, JSON.stringify({ 'camera.kt': { 1: 4 } }))
    assert.throws(
      () => mergeReports(source, [{ ...reports[0], digest: undefined }], root),
      /require measurement provenance/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing files and per-file gaps fail even when the overall percentage is high', () => {
  const changes = { 'one.kt': new Set([1]), 'two.swift': new Set([1]) }
  assert.equal(evaluate(changes, { 'one.kt': { 1: 1 } }, [], 95).pass, false)
  const many = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [i + 1, 1])
  )
  const report = evaluate(
    {
      'one.kt': new Set(Object.keys(many).map(Number)),
      'two.swift': new Set([1])
    },
    { 'one.kt': many, 'two.swift': { 1: 0 } },
    [],
    95
  )
  assert(report.percent > 95)
  assert.equal(report.pass, false)
  assert.equal(
    evaluate(
      { 'new.kt': new Set([1]) },
      { 'new.kt': { 1: 1, 2: 0 } },
      ['new.kt'],
      95
    ).pass,
    false
  )
})

test('collector options stop at the test-command separator', () => {
  const command = [
    'record',
    'meta',
    '--',
    'test-command',
    '--base',
    'test-base'
  ]
  assert.deepEqual(coverageArguments(command), {
    base: 'origin/develop',
    args: command
  })
  assert.deepEqual(coverageArguments(['--base', 'branch', ...command]), {
    base: 'branch',
    args: command
  })
  assert.throws(
    () => coverageArguments(['--base', '--', 'test-command']),
    /requires a ref/
  )
})
