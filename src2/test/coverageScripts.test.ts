import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  executableFile,
  globPattern,
  main
} = require('../../scripts/changed-line-check.cjs')

/**
 * `changed-line-check.cjs`'s `main`, with a fake `run` handing it canned
 * `git` output and a coverage report written to a temporary directory.
 */

const TOP = '/repo'
const BASE = 'abc123'

/** A diff adding `lines` lines to each file, as `git diff --unified=0` does. */
function diffOf(files: Record<string, number>): string {
  return Object.entries(files)
    .map(
      ([path, lines]) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
        `@@ -0,0 +1,${lines} @@\n` +
        Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join('\n')
    )
    .join('\n')
}

/** Counts every line of each file as run, or `uncovered` of them as not. */
function countsOf(
  files: Record<string, number>,
  uncovered: Record<string, number> = {}
): string {
  const dir = mkdtempSync(join(tmpdir(), 'changed-line-check-'))
  const path = join(dir, 'counts.json')
  const counts: Record<string, Record<number, number>> = {}
  for (const [file, lines] of Object.entries(files)) {
    counts[join(TOP, file)] = Object.fromEntries(
      Array.from({ length: lines }, (_, i) => [
        i + 1,
        i < (uncovered[file] ?? 0) ? 0 : 1
      ])
    )
  }
  writeFileSync(path, JSON.stringify(counts))
  return path
}

interface Run {
  code: number
  log: string[]
  calls: string[][]
}

function check(
  argv: string[],
  diff: string,
  added: string[] = [],
  cwd = TOP
): Run {
  const log: string[] = []
  const calls: string[][] = []
  const run = (file: string, args: string[]): string => {
    calls.push([file, ...args])
    if (args[0] === 'rev-parse') return `${TOP}\n`
    if (args[0] === 'merge-base') return `${BASE}\n`
    if (args.includes('--name-only')) return added.join('\n')
    return diff
  }
  const code = main(argv, { run, log: (line: string) => log.push(line), cwd })
  return { code, log, calls }
}

describe('the changed-line check', function () {
  it('fails on an empty diff unless --allow-empty, and diffs from the merge base', function () {
    const counts = countsOf({})
    const empty = check(['--counts', counts, '--ext', '.ts', 'src2/server'], '')
    expect(empty.code).equals(1)
    expect(empty.log[0]).includes('nothing changed under src2/server')
    expect(empty.calls[2]).deep.equals([
      'git',
      '-C',
      TOP,
      'diff',
      '--unified=0',
      `${BASE}...HEAD`,
      '--',
      'src2/server'
    ])
    expect(
      check(
        ['--counts', counts, '--ext', '.ts', '--allow-empty', 'src2/server'],
        ''
      ).code
    ).equals(0)
  })

  it('passes covered code and fails, with the report printed, on uncovered code', function () {
    const files = { 'src2/server/a.ts': 10 }
    const good = check(
      ['--counts', countsOf(files), '--ext', '.ts', 'src2/server'],
      diffOf(files)
    )
    expect(good.code).equals(0)
    expect(good.log.at(-1)).equals(
      'Changed executable line coverage: 10/10 (100.00%)'
    )
    const bad = check(
      [
        '--counts',
        countsOf(files, { 'src2/server/a.ts': 2 }),
        '--ext',
        '.ts',
        'src2/server'
      ],
      diffOf(files)
    )
    expect(bad.code).equals(1)
    expect(bad.log).deep.equals([
      '  src2/server/a.ts: 80.0% (8/10)',
      '    uncovered: 1,2',
      'Changed executable line coverage: 8/10 (80.00%) FAILED'
    ])
  })

  it('holds an added file to 90% on its own, and fails a file with no record', function () {
    const files = { 'src2/server/old.ts': 90, 'src2/server/new.ts': 10 }
    const counts = countsOf(files, { 'src2/server/new.ts': 2 })
    const short = check(
      ['--counts', counts, '--ext', '.ts', 'src2/server'],
      diffOf(files),
      ['src2/server/new.ts']
    )
    expect(short.code).equals(1)
    expect(short.log).to.include(
      '  src2/server/new.ts: a new file under 90% on its own'
    )
    expect(short.log).to.include('  src2/server/new.ts (new): 80.0% (8/10)')
    const missing = check(
      ['--counts', countsOf({}), '--ext', '.ts', 'src2/server'],
      diffOf({ 'src2/server/lost.ts': 3 })
    )
    expect(missing.code).equals(1)
    expect(missing.log).to.include('  src2/server/lost.ts: no coverage record')
  })

  it('counts only the named extensions, and never tests or end-to-end files', function () {
    const files = {
      'src2/app/Screen.tsx': 5,
      'scripts/run.sh': 5,
      'maestro/flow.yaml': 5,
      'src2/server/thing.test.ts': 5,
      'src2/server/thing.e2e.ts': 5
    }
    const run = check(
      ['--counts', countsOf({}), '--ext', '.ts', '.'],
      diffOf(files)
    )
    expect(run.code).equals(0)
    expect(run.log.at(-1)).includes('0/0')
    expect(executableFile('a/b.cjs', ['.cjs'])).equals(true)
    expect(executableFile('a/b.test.cjs', ['.cjs'])).equals(false)
    expect(executableFile('a/b.swift', ['.ts', '.swift'])).equals(true)
  })

  it('honours --exclude, by path, by directory and by glob', function () {
    const files = {
      'src2/server/index.ts': 5,
      'src2/server/dev/tool.ts': 5,
      'mobile/apps/gsDirector/Tests/DirectorUnitTests/X.swift': 5,
      'mobile/apps/common/DirectorExport/Tests/DirectorExportTests/Y.swift': 5,
      'mobile/apps/common/DirectorExport/Sources/Z.swift': 5
    }
    const counts = countsOf({
      'mobile/apps/common/DirectorExport/Sources/Z.swift': 5
    })
    const run = check(
      [
        '--counts',
        counts,
        '--ext',
        '.ts',
        '--ext',
        '.swift',
        '--exclude',
        'src2/server/index.ts',
        '--exclude',
        'src2/server/dev',
        '--exclude',
        '**/Tests/**',
        '.'
      ],
      diffOf(files)
    )
    expect(run.code, run.log.join('\n')).equals(0)
    expect(run.log.at(-1)).includes('5/5')
    const tests = globPattern('**/Tests/**')
    expect(
      tests.test('mobile/apps/gsDirector/Tests/DirectorUnitTests/X.swift')
    ).equals(true)
    expect(
      tests.test(
        'mobile/apps/common/DirectorExport/Tests/DirectorExportTests/Y.swift'
      )
    ).equals(true)
    expect(
      tests.test('mobile/apps/common/DirectorExport/Sources/Z.swift')
    ).equals(false)
    expect(globPattern('src2/*.ts').test('src2/a/b.ts')).equals(false)
    expect(globPattern('src2/?.ts').test('src2/a.ts')).equals(true)
  })

  it('reads an Istanbul report, resolving pathspecs from a subdirectory', function () {
    const dir = mkdtempSync(join(tmpdir(), 'changed-line-check-'))
    const coverage = join(dir, 'coverage-final.json')
    writeFileSync(
      coverage,
      JSON.stringify({
        [join(TOP, 'src2/server/a.ts')]: {
          statementMap: { a: { start: { line: 1 }, end: { line: 2 } } },
          s: { a: 1 }
        }
      })
    )
    const run = check(
      ['--coverage', coverage, '--ext', '.ts', '.'],
      diffOf({ 'src2/server/a.ts': 2 }),
      [],
      join(TOP, 'src2/server')
    )
    expect(run.code).equals(0)
    expect(run.calls[2].at(-1)).equals('src2/server')
  })

  it('refuses arguments it cannot use', function () {
    for (const argv of [
      ['--ext', '.ts', 'src2'],
      ['--counts', 'x', '--coverage', 'y', '--ext', '.ts'],
      ['--counts', 'x', 'src2'],
      ['--counts', 'x', '--ext'],
      ['--counts', 'x', '--ext', '.ts', '--frobnicate']
    ]) {
      const run = check(argv, '')
      expect(run.code, argv.join(' ')).equals(2)
      expect(run.log[0]).includes('usage:')
      expect(run.calls).deep.equals([])
    }
  })
})
