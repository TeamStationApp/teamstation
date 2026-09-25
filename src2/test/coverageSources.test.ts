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
    const dir = mkdtempSync(join(tmpdir(), 'gs-coverage-sources-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    try {
      git('init', '-q', '-b', 'master')
      mkdirSync(join(dir, 'src2/app'), { recursive: true })
      for (const name of [
        'deleted.ts',
        'kept.ts',
        'unchanged.ts',
        'ignored.test.ts'
      ])
        writeFileSync(join(dir, 'src2/app', name), 'export const value = 1\n')
      git('add', '.')
      git('commit', '-qm', 'Coverage test fixture')
      rmSync(join(dir, 'src2/app/deleted.ts'))
      for (const name of ['kept.ts', 'new.ts', 'ignored.test.ts'])
        writeFileSync(join(dir, 'src2/app', name), 'export const value = 2\n')
      const result = coverageSources('HEAD', dir)
      expect(result.paths.sort()).deep.equals([
        'src2/app/kept.ts',
        'src2/app/new.ts'
      ])
      expect(result.untracked).deep.equals(['src2/app/new.ts'])
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
})
