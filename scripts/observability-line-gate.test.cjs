const { strict: assert } = require('node:assert')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { describe, it } = require('mocha')
const {
  evaluate,
  production,
  verifySource,
  snapshot,
  gate
} = require('./observability-line-gate.cjs')

describe('observability coverage gate', () => {
  it('enforces per-file and total boundaries including new files and missing records', () => {
    const lines = new Set(Array.from({ length: 100 }, (_, i) => i + 1))
    const counters = n =>
      Object.fromEntries([...lines].map(i => [i, i <= n ? 1 : 0]))
    assert.equal(evaluate({ a: lines }, { a: counters(95) }, ['a']).pass, true)
    assert.equal(evaluate({ a: lines }, { a: counters(94) }, ['a']).pass, false)
    assert.equal(
      evaluate({ a: lines, b: lines }, { a: counters(100), b: counters(94) })
        .pass,
      false
    )
    assert.equal(evaluate({ a: lines }, {}).pass, false)
    assert.equal(evaluate({ a: new Set() }, { a: {} }).pass, true)
  })
  it('refuses counters from another source state', () => {
    verifySource({ stamp: 'same' }, { stamp: 'same' })
    assert.throws(() => verifySource({ stamp: 'one' }, { stamp: 'two' }))
  })
  it('counts production files without treating tests or manifests as application code', () => {
    for (const p of ['src/a.ts', 'a.swift', 'a.kt', 'scripts/a.mjs'])
      assert.equal(production(p), true)
    for (const p of [
      'a.test.ts',
      'a.e2e.ts',
      'test/a.kt',
      'x/Tests/a.swift',
      'Package.swift',
      'README.md'
    ])
      assert.equal(production('/' + p), false)
  })
  it('fingerprints untracked source independently of the checkout state', () => {
    const root = mkdtempSync(join(tmpdir(), 'coverage-source-'))
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    try {
      git('init', '-b', 'master')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Fixture')
      git('update-ref', 'refs/remotes/origin/master', 'HEAD')
      writeFileSync(join(root, 'new.ts'), 'export const value = 1\n')
      writeFileSync(join(root, 'note.txt'), 'fixture')
      const first = snapshot(root)
      assert.deepEqual([...first.changes['new.ts']], [1, 2])
      assert.equal(first.changes['note.txt'], undefined)
      assert.ok(first.newFiles.includes('new.ts'))
      writeFileSync(join(root, 'new.ts'), 'export const value = 2\n')
      assert.throws(() => verifySource(first, snapshot(root)))
      git('add', 'new.ts')
      assert.ok(snapshot(root).newFiles.includes('new.ts'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('reads the current working source snapshot', () => {
    const before = snapshot()
    assert.equal(typeof before.stamp, 'string')
    const counts = Object.fromEntries(
      Object.entries(before.changes).map(([p, lines]) => [
        p,
        Object.fromEntries([...lines].map(line => [line, 1]))
      ])
    )
    assert.equal(
      gate(
        before,
        counts,
        () => true,
        () => {}
      ).pass,
      true
    )
    assert.throws(() =>
      gate(
        before,
        {},
        () => true,
        () => {}
      )
    )
    assert.equal(
      gate(
        before,
        {},
        () => false,
        () => {}
      ).pass,
      true
    )
  })
})
