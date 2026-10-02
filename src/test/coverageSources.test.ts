import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
const { coverageSources } = require('../../scripts/coverage-source-paths.cjs')
const { lineReport } = require('../../scripts/changed-line-coverage.cjs')
describe('coverage source enumeration', () => {
  it('omits deleted helpers but requires coverage for surviving and untracked executable source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-coverage-sources-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    try {
      git('init', '-q', '-b', 'master')
      mkdirSync(join(dir, 'src/app'), { recursive: true })
      for (const name of [
        'deleted.ts',
        'kept.ts',
        'unchanged.ts',
        'ignored.test.ts'
      ])
        writeFileSync(join(dir, 'src/app', name), 'export const value = 1\n')
      git('add', '.')
      git('commit', '-qm', 'Coverage test fixture')
      rmSync(join(dir, 'src/app/deleted.ts'))
      for (const name of ['kept.ts', 'new.ts', 'ignored.test.ts'])
        writeFileSync(join(dir, 'src/app', name), 'export const value = 2\n')
      const result = coverageSources('HEAD', dir)
      expect(result.paths.sort()).deep.equals([
        'src/app/kept.ts',
        'src/app/new.ts'
      ])
      expect(result.untracked).deep.equals(['src/app/new.ts'])
      const changed = Object.fromEntries(
        result.paths.map((path: string) => [path, new Set([1])])
      )
      const report = lineReport(changed, {}, () => true)
      expect(report.pass).equals(false)
      expect(report.missing.sort()).deep.equals(result.paths)
      expect(coverageSources('HEAD').paths).to.be.an('array')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves out a file moved without an edit, and keeps one moved and edited', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-coverage-sources-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    try {
      git('init', '-q', '-b', 'master')
      mkdirSync(join(dir, 'old/app'), { recursive: true })
      mkdirSync(join(dir, 'src'), { recursive: true })
      const body = Array.from(
        { length: 20 },
        (_, i) => `export const v${i} = ${i}`
      )
      writeFileSync(join(dir, 'old/app/moved.ts'), body.join('\n') + '\n')
      writeFileSync(join(dir, 'old/app/edited.ts'), body.join('\n') + '\n')
      writeFileSync(join(dir, 'old/app/elsewhere.ts'), 'export const x = 1\n')
      git('add', '.')
      git('commit', '-qm', 'Coverage test fixture')
      git('mv', 'old/app', 'src/app')
      git('mv', 'src/app/elsewhere.ts', 'elsewhere.ts')
      writeFileSync(
        join(dir, 'src/app/edited.ts'),
        [...body.slice(0, 19), 'export const v19 = 190'].join('\n') + '\n'
      )
      git('add', '.')
      const result = coverageSources('HEAD', dir)
      expect(result.paths).deep.equals(['src/app/edited.ts'])
      expect(result.untracked).deep.equals([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
