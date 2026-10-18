const { strict: assert } = require('node:assert')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')

const {
  coverageSource,
  verifyCoverageSource
} = require('./coverage-provenance.cjs')

test('coverage provenance rejects dirty files, new revisions and missing metadata', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'coverage-source-'))
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  try {
    git('init')
    git('config', 'user.name', 'Test Author')
    git('config', 'user.email', 'author@example.test')
    const file = join(cwd, 'source.js')
    writeFileSync(file, 'module.exports = 1\n')
    git('add', '.')
    git('commit', '-m', 'Initial source')
    const collected = coverageSource(cwd, 'HEAD')
    assert.doesNotThrow(() => verifyCoverageSource(collected, cwd, 'HEAD'))
    assert.throws(
      () => verifyCoverageSource(undefined, cwd, 'HEAD'),
      /different source/
    )
    writeFileSync(file, 'module.exports = 2\n')
    assert.throws(
      () => verifyCoverageSource(collected, cwd, 'HEAD'),
      /clean committed/
    )
    git('add', '.')
    git('commit', '-m', 'Changed source')
    assert.throws(
      () => verifyCoverageSource(collected, cwd, 'HEAD'),
      /different source/
    )
    const current = coverageSource(cwd, 'HEAD')
    assert.doesNotThrow(() => verifyCoverageSource(current, cwd, 'HEAD'))
    assert.throws(
      () => verifyCoverageSource(current, cwd, 'HEAD^'),
      /different source/
    )
    writeFileSync(join(cwd, 'new.js'), 'new source\n')
    assert.throws(
      () => verifyCoverageSource(current, cwd, 'HEAD'),
      /clean committed/
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
