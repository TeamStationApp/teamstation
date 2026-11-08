const { strict: assert } = require('node:assert')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { coverageSource } = require('./coverage-provenance.cjs')
const {
  scoringCombinedCoverage,
  verifyScoringBundle
} = require('./scoring-combined-coverage.cjs')

test('scoring coverage merges counters and rejects absent, stale or unmapped evidence', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'scoring-coverage-'))
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  try {
    git('init')
    git('config', 'user.name', 'Test Author')
    git('config', 'user.email', 'author@example.test')
    const sourceFile = join(cwd, 'src/app/scoring/ScoringScreen.tsx')
    mkdirSync(join(cwd, 'src/app/scoring'), { recursive: true })
    writeFileSync(sourceFile, 'const a = 1\nconst b = 2\n')
    writeFileSync(join(cwd, '.gitignore'), 'evidence/\n')
    git('add', '.')
    git('commit', '-m', 'Measured source')
    const source = coverageSource(cwd, 'HEAD')
    const evidence = join(cwd, 'evidence')
    mkdirSync(evidence)
    const counts = (a, b) => ({
      [sourceFile]: {
        path: sourceFile,
        statementMap: {
          0: { start: { line: 1, column: 0 }, end: { line: 1, column: 11 } },
          1: { start: { line: 2, column: 0 }, end: { line: 2, column: 11 } }
        },
        fnMap: {},
        branchMap: {},
        s: { 0: a, 1: b },
        f: {},
        b: {}
      }
    })
    const files = [join(evidence, 'a.json'), join(evidence, 'b.json')]
    writeFileSync(files[0], JSON.stringify(counts(0, 3)))
    writeFileSync(files[1], JSON.stringify(counts(0, 4)))
    const manifest = join(evidence, 'manifest.json')
    const save = value => writeFileSync(manifest, JSON.stringify(value))
    save({ source, files })
    assert.deepEqual(
      scoringCombinedCoverage(counts(4, 0), manifest, cwd, 'HEAD')[sourceFile]
        .s,
      { 0: 4, 1: 7 }
    )
    assert.throws(
      () => scoringCombinedCoverage({}, undefined, cwd, 'HEAD'),
      /Supply/
    )
    save({ source, files: [] })
    assert.throws(
      () => scoringCombinedCoverage({}, manifest, cwd, 'HEAD'),
      /both scoring/
    )
    save({ source: { ...source, revision: 'other' }, files })
    assert.throws(
      () => scoringCombinedCoverage({}, manifest, cwd, 'HEAD'),
      /different source/
    )
    save({ source, files })
    writeFileSync(files[0], '{}')
    assert.throws(
      () => scoringCombinedCoverage({}, manifest, cwd, 'HEAD'),
      /Missing mapped/
    )
    const map = join(evidence, 'bundle.js.map')
    writeFileSync(
      map,
      JSON.stringify({
        sources: ['../src/app/scoring/ScoringScreen.tsx'],
        sourcesContent: ['const a = 1\nconst b = 2\n']
      })
    )
    verifyScoringBundle(map, cwd)
    writeFileSync(sourceFile, 'changed\n')
    assert.throws(() => verifyScoringBundle(map, cwd), /Stale scoring/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
