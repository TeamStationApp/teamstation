import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const {
  executableFile,
  globPattern,
  main,
  underSpecs
} = require('../../scripts/changed-line-check.cjs')
const swift = require('../../scripts/swift-changed-line-coverage.cjs')

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

/** A diff touching `lines` of each file, one hunk a line. */
function linesDiffOf(files: Record<string, number[]>): string {
  return Object.entries(files)
    .map(
      ([path, lines]) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
        lines.map(line => `@@ -0,0 +${line} @@\n+x`).join('\n')
    )
    .join('\n')
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
    const empty = check(['--counts', counts, '--ext', '.ts', 'src/server'], '')
    expect(empty.code).equals(1)
    expect(empty.log[0]).includes('nothing changed under src/server')
    expect(empty.calls[2]).deep.equals([
      'git',
      '-C',
      TOP,
      'diff',
      '--unified=0',
      '--find-renames',
      `${BASE}...HEAD`
    ])
    expect(
      check(
        ['--counts', counts, '--ext', '.ts', '--allow-empty', 'src/server'],
        ''
      ).code
    ).equals(0)
  })

  it('counts only the edited lines of a moved file, and nothing of a pure move', function () {
    const renamed =
      'diff --git a/src2/server/a.ts b/src/server/a.ts\n' +
      'similarity index 100%\n' +
      'rename from src2/server/a.ts\n' +
      'rename to src/server/a.ts\n' +
      'diff --git a/src2/server/b.ts b/src/server/b.ts\n' +
      'similarity index 90%\n' +
      'rename from src2/server/b.ts\n' +
      'rename to src/server/b.ts\n' +
      '--- a/src2/server/b.ts\n' +
      '+++ b/src/server/b.ts\n' +
      '@@ -4,2 +4,2 @@\n' +
      '-old 4\n-old 5\n+new 4\n+new 5'
    const counts = countsOf({ 'src/server/b.ts': 10 }, { 'src/server/b.ts': 3 })
    const run = check(
      ['--counts', counts, '--ext', '.ts', 'src/server'],
      renamed
    )
    expect(run.log).deep.includes('  src/server/b.ts: 100.0% (2/2)')
    expect(run.log.some(line => line.includes('src/server/a.ts'))).equals(false)
    expect(run.code).equals(0)
    const pure = check(
      ['--counts', countsOf({}), '--ext', '.ts', 'src/server'],
      renamed.slice(0, renamed.indexOf('diff --git a/src2/server/b.ts'))
    )
    expect(pure.log[0]).includes('nothing changed under src/server')
  })

  it('applies the pathspecs to the whole-tree diff and to the added files', function () {
    const files = { 'src/server/a.ts': 4, 'mobile/x.ts': 4 }
    const counts = countsOf(
      { 'src/server/a.ts': 4, 'mobile/x.ts': 4 },
      { 'src/server/a.ts': 1 }
    )
    const run = check(
      ['--counts', counts, '--ext', '.ts', 'src/server/'],
      diffOf(files),
      ['src/server/a.ts', 'mobile/x.ts']
    )
    expect(run.log).deep.includes('  src/server/a.ts (new): 75.0% (3/4)')
    expect(run.log.some(line => line.includes('mobile/x.ts'))).equals(false)
    expect(run.log).deep.includes(
      '  src/server/a.ts: a new file under 90% on its own'
    )
    expect(run.code).equals(1)
    expect(underSpecs(['.'])('anything/at/all.ts')).equals(true)
    expect(underSpecs(['src'])('src')).equals(true)
    expect(underSpecs(['src'])('srcx/a.ts')).equals(false)
  })

  it('passes covered code and fails, with the report printed, on uncovered code', function () {
    const files = { 'src/server/a.ts': 10 }
    const good = check(
      ['--counts', countsOf(files), '--ext', '.ts', 'src/server'],
      diffOf(files)
    )
    expect(good.code).equals(0)
    expect(good.log.at(-1)).equals(
      'Changed executable line coverage: 10/10 (100.00%)'
    )
    const bad = check(
      [
        '--counts',
        countsOf(files, { 'src/server/a.ts': 2 }),
        '--ext',
        '.ts',
        'src/server'
      ],
      diffOf(files)
    )
    expect(bad.code).equals(1)
    expect(bad.log).deep.equals([
      '  src/server/a.ts: 80.0% (8/10)',
      '    uncovered: 1,2',
      'Changed executable line coverage: 8/10 (80.00%) FAILED'
    ])
  })

  it('holds an added file to 90% on its own, and fails a file with no record', function () {
    const files = { 'src/server/old.ts': 90, 'src/server/new.ts': 10 }
    const counts = countsOf(files, { 'src/server/new.ts': 2 })
    const short = check(
      ['--counts', counts, '--ext', '.ts', 'src/server'],
      diffOf(files),
      ['src/server/new.ts']
    )
    expect(short.code).equals(1)
    expect(short.log).to.include(
      '  src/server/new.ts: a new file under 90% on its own'
    )
    expect(short.log).to.include('  src/server/new.ts (new): 80.0% (8/10)')
    const missing = check(
      ['--counts', countsOf({}), '--ext', '.ts', 'src/server'],
      diffOf({ 'src/server/lost.ts': 3 })
    )
    expect(missing.code).equals(1)
    expect(missing.log).to.include('  src/server/lost.ts: no coverage record')
  })

  it('counts only the named extensions, and never tests or end-to-end files', function () {
    const files = {
      'src/app/Screen.tsx': 5,
      'scripts/run.sh': 5,
      'maestro/flow.yaml': 5,
      'src/server/thing.test.ts': 5,
      'src/server/thing.e2e.ts': 5
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
      'src/server/index.ts': 5,
      'src/server/dev/tool.ts': 5,
      'mobile/apps/tsDirector/Tests/DirectorUnitTests/X.swift': 5,
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
        'src/server/index.ts',
        '--exclude',
        'src/server/dev',
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
      tests.test('mobile/apps/tsDirector/Tests/DirectorUnitTests/X.swift')
    ).equals(true)
    expect(
      tests.test(
        'mobile/apps/common/DirectorExport/Tests/DirectorExportTests/Y.swift'
      )
    ).equals(true)
    expect(
      tests.test('mobile/apps/common/DirectorExport/Sources/Z.swift')
    ).equals(false)
    expect(globPattern('src/*.ts').test('src/a/b.ts')).equals(false)
    expect(globPattern('src/?.ts').test('src/a.ts')).equals(true)
  })

  it('reads an Istanbul report, resolving pathspecs from a subdirectory', function () {
    const dir = mkdtempSync(join(tmpdir(), 'changed-line-check-'))
    const coverage = join(dir, 'coverage-final.json')
    writeFileSync(
      coverage,
      JSON.stringify({
        [join(TOP, 'src/server/a.ts')]: {
          statementMap: { a: { start: { line: 1 }, end: { line: 2 } } },
          s: { a: 1 }
        }
      })
    )
    const run = check(
      ['--coverage', coverage, '--ext', '.ts', '.'],
      diffOf({ 'src/server/a.ts': 2, 'src/app/b.ts': 2 }),
      [],
      join(TOP, 'src/server')
    )
    expect(run.code).equals(0)
    expect(run.log).deep.includes('  src/server/a.ts: 100.0% (2/2)')
    expect(run.log.some(line => line.includes('src/app/b.ts'))).equals(false)
  })

  it('reads a JaCoCo report against its source roots', function () {
    const root = 'mobile/apps/kt/app/src/main/kotlin'
    const tally = `${root}/app/example/tally/Tally.kt`
    const lost = 'mobile/apps/kt/app/src/other/Lost.kt'
    const run = check(
      [
        '--jacoco',
        resolve('src/test/fixtures/coverage/tally.jacoco.xml'),
        '--source-root',
        'apps/kt/app/src/main/kotlin',
        '--ext',
        '.kt',
        '.'
      ],
      linesDiffOf({ [tally]: [4, 5, 6, 7, 8, 9], [lost]: [1] }),
      [],
      join(TOP, 'mobile')
    )
    expect(run.log).deep.includes(`  ${tally}: 75.0% (3/4)`)
    expect(run.log).deep.includes('    uncovered: 7')
    expect(run.log).deep.includes(`  ${lost}: no coverage record`)
    expect(run.code).equals(1)
  })

  it('refuses arguments it cannot use', function () {
    for (const argv of [
      ['--ext', '.ts', 'src'],
      ['--counts', 'x', '--coverage', 'y', '--ext', '.ts'],
      ['--counts', 'x', 'src'],
      ['--counts', 'x', '--ext'],
      ['--counts', 'x', '--ext', '.ts', '--frobnicate'],
      ['--jacoco', 'x', '--ext', '.kt', 'src'],
      ['--counts', 'x', '--source-root', 'y', '--ext', '.ts', 'src'],
      ['--jacoco', 'x', '--counts', 'y', '--source-root', 'z', '--ext', '.kt'],
      ['--jacoco', 'x', '--ext', '.kt', '--source-root']
    ]) {
      const run = check(argv, '')
      expect(run.code, argv.join(' ')).equals(2)
      expect(run.log[0]).includes('usage:')
      expect(run.calls).deep.equals([])
    }
  })
})

/**
 * `swift-changed-line-coverage.cjs`'s `main`, with a fake `run` handing it
 * canned `git`, `swift` and `xcrun` output: the recorded lcov and xccov
 * reports of the small `Tally` package.
 */

const recorded = (name: string): string =>
  readFileSync(`src/test/fixtures/coverage/${name}`, 'utf8')

const TALLY = 'Tally/Sources/Tally/Tally.swift'
const TALLY_TEST = 'Tally/Tests/TallyTests/TallyTests.swift'

/** A diff touching `lines` of each file, as `git diff --unified=0` does. */
function linesDiff(files: Record<string, number[]>): string {
  return Object.entries(files)
    .map(
      ([path, lines]) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
        lines.map(line => `@@ -0,0 +${line} @@\n+x`).join('\n')
    )
    .join('\n')
}

function swiftCheck(
  argv: string[],
  files: Record<string, number[]>,
  { top = TOP, reports = TOP, fail = '', recordsNothing = false } = {}
): Run {
  const log: string[] = []
  const calls: string[][] = []
  const run = (file: string, args: string[]): string => {
    calls.push([file, ...args])
    if (fail !== '' && args.includes(fail)) {
      const error: Error & { stdout?: string } = new Error(`${fail} failed`)
      error.stdout = 'Test run with 3 tests failed'
      throw error
    }
    if (args[0] === 'rev-parse') return `${top}\n`
    if (args[0] === 'merge-base') return `${BASE}\n`
    if (args.includes('--diff-filter=A')) return ''
    if (args.includes('--name-only')) return Object.keys(files).join('\n')
    if (file === 'git') return linesDiff(files)
    if (args.includes('--show-codecov-path'))
      return `${reports}/Tally/.build/debug/codecov/Tally.json\n`
    if (args.includes('--show-bin-path'))
      return `${reports}/Tally/.build/debug\n`
    if (args.includes('describe')) return '{"name":"Tally"}'
    if (args[0] === 'llvm-cov')
      return recorded('tally.lcov').replaceAll('/repo/', `${reports}/`)
    if (args.includes('--file-list'))
      return (recordsNothing ? [] : [TALLY, TALLY_TEST, 'Other/Skip.swift'])
        .map(path => `${reports}/${path}`)
        .join('\n')
    if (args.includes('--file'))
      return recorded('tally.xccov.json').replaceAll('/repo/', `${reports}/`)
    if (file === 'find' && args[0].endsWith('ProfileData'))
      return [
        `100 ${reports}/DD/Build/ProfileData/OLD/Coverage.profdata`,
        `200 ${reports}/DD/Build/ProfileData/SIM/Coverage.profdata`
      ].join('\n')
    if (file === 'find')
      return [
        `${reports}/DD/Build/Products/Debug-iphonesimulator/TS Director.app`,
        `${reports}/DD/Build/Products/Debug-iphonesimulator/PackageFrameworks/Tally_1_PackageProduct.framework`
      ].join('\n')
    return ''
  }
  const code = swift.main(argv, {
    run,
    log: (line: string) => log.push(line),
    cwd: top
  })
  return { code, log, calls }
}

describe('the Swift changed-line coverage', function () {
  it("runs a package's tests with coverage and reads the exported lcov", function () {
    const run = swiftCheck(['--spm', 'Tally', 'Tally'], {
      [TALLY]: [2, 3, 4, 5, 6, 7, 8]
    })
    expect(run.code, run.log.join('\n')).equals(0)
    expect(run.log.at(-1)).equals(
      'Changed executable line coverage: 6/6 (100.00%)'
    )
    expect(run.calls).to.deep.include([
      'swift',
      'test',
      '--enable-code-coverage',
      '--package-path',
      `${TOP}/Tally`
    ])
    expect(run.calls).to.deep.include([
      'xcrun',
      'llvm-cov',
      'export',
      '-format=lcov',
      '-instr-profile',
      `${TOP}/Tally/.build/debug/codecov/default.profdata`,
      `${TOP}/Tally/.build/debug/TallyPackageTests.xctest/Contents/MacOS/TallyPackageTests`
    ])
  })

  it('always passes --ext .swift and --exclude **/Tests/**, so tests never count', function () {
    // Tally.swift alone is 6 of 7; the covered test file would lift it to 11
    // of 12 and pass, which is exactly what must not happen.
    const run = swiftCheck(['--spm', 'Tally', 'Tally'], {
      [TALLY]: [2, 3, 5, 6, 7, 8, 9],
      [TALLY_TEST]: [5, 6, 7, 8, 9],
      'Tally/README.md': [1]
    })
    expect(run.code).equals(1)
    expect(run.log.at(-1)).equals(
      'Changed executable line coverage: 6/7 (85.71%) FAILED'
    )
    expect(run.log.join('\n')).not.includes('TallyTests.swift')
  })

  it('reads each changed file out of a result bundle by the path it recorded', function () {
    // The build recorded the real path of a top level reached through a
    // symlink, as /tmp is on macOS.
    const top = mkdtempSync(join(tmpdir(), 'swift-changed-line-'))
    const reports = realpathSync(top)
    const run = swiftCheck(
      ['--xcresult', 'Result.xcresult', '--exclude', 'Other', 'Tally', 'Other'],
      {
        [TALLY]: [2, 3, 5, 6, 7, 8, 9, 11],
        [TALLY_TEST]: [5],
        'Other/Skip.swift': [1]
      },
      { top, reports }
    )
    expect(run.code, run.log.join('\n')).equals(1)
    expect(run.log.at(-1)).equals(
      'Changed executable line coverage: 7/8 (87.50%) FAILED'
    )
    const asked = run.calls.filter(call => call.includes('--file'))
    expect(asked).deep.equals([
      [
        'xcrun',
        'xccov',
        'view',
        '--archive',
        '--json',
        '--file',
        `${reports}/${TALLY}`,
        `${top}/Result.xcresult`
      ]
    ])
    const merged = run.calls.find(
      call =>
        call[0] === 'git' &&
        call.includes('--name-only') &&
        !call.includes('--diff-filter=A')
    )
    expect(merged?.slice(-3)).deep.equals(['--', 'Tally', 'Other'])
  })

  it('matches records under either spelling of a top level reached through a symlink', function () {
    // A real checkout, and a symlink to it standing in for /tmp → /private/tmp.
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'swift-real-')))
    const link = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'swift-link-'))),
      'checkout'
    )
    symlinkSync(real, link)
    for (const path of [TALLY, TALLY_TEST, 'Other/Skip.swift']) {
      mkdirSync(dirname(join(real, path)), { recursive: true })
      writeFileSync(join(real, path), '')
    }
    const files = { [TALLY]: [2, 3, 5, 6, 7, 8, 9, 11], [TALLY_TEST]: [5] }
    // git gives the real path and the build recorded the link, as QA found,
    // and the other way round.
    for (const [top, reports] of [
      [real, link],
      [link, real]
    ]) {
      const bundle = swiftCheck(
        ['--xcresult', 'Result.xcresult', 'Tally'],
        files,
        { top, reports }
      )
      expect(bundle.log.at(-1), `${top} ← ${reports}`).equals(
        'Changed executable line coverage: 7/8 (87.50%) FAILED'
      )
      expect(
        bundle.calls
          .filter(call => call.includes('--file'))
          .map(call => call[6])
      ).deep.equals([`${reports}/${TALLY}`])
      const spm = swiftCheck(['--spm', 'Tally', 'Tally'], files, {
        top,
        reports
      })
      expect(spm.log.join('\n')).not.includes('no coverage record')
      expect(spm.log.at(-1)).matches(
        /^Changed executable line coverage: \d+\/[1-9]/
      )
    }
  })

  it('adds the package frameworks from the newest profile under DerivedData', function () {
    // Without the result bundle's report, llvm-cov over the frameworks built
    // beside the app still has the package's source.
    const run = swiftCheck(
      ['--xcresult', 'DD/Result.xcresult', '--derived-data', 'DD', 'Tally'],
      { [TALLY]: [2, 3, 5, 6, 7, 8, 11], [TALLY_TEST]: [5] },
      { recordsNothing: true }
    )
    expect(run.code, run.log.join('\n')).equals(0)
    expect(run.log.at(-1)).equals(
      'Changed executable line coverage: 7/7 (100.00%)'
    )
    expect(run.calls.filter(call => call.includes('--file'))).deep.equals([])
    const exported = run.calls.find(call => call[1] === 'llvm-cov')
    expect(exported).deep.equals([
      'xcrun',
      'llvm-cov',
      'export',
      '-format=lcov',
      '-instr-profile',
      `${TOP}/DD/Build/ProfileData/SIM/Coverage.profdata`,
      `${TOP}/DD/Build/Products/Debug-iphonesimulator/TS Director.app/TS Director`,
      '-object',
      `${TOP}/DD/Build/Products/Debug-iphonesimulator/PackageFrameworks/Tally_1_PackageProduct.framework/Tally_1_PackageProduct`
    ])
    // Both reports of one file count a line as the busier one does.
    const both = swiftCheck(
      ['--xcresult', 'DD/Result.xcresult', '--derived-data', 'DD', 'Tally'],
      { [TALLY]: [2, 3, 5, 6, 7, 8, 11] }
    )
    expect(both.code, both.log.join('\n')).equals(0)
  })

  it('says when DerivedData holds no profile', function () {
    const log: string[] = []
    const code = swift.main(
      ['--xcresult', 'R.xcresult', '--derived-data', 'DD', 'Tally'],
      {
        run: (file: string, args: string[]): string => {
          if (args[0] === 'rev-parse') return `${TOP}\n`
          if (args[0] === 'merge-base') return `${BASE}\n`
          return ''
        },
        log: (line: string) => log.push(line),
        cwd: TOP
      }
    )
    expect(code).equals(1)
    expect(log.at(-1)).equals(
      `could not read Swift coverage: no Coverage.profdata under ${TOP}/DD`
    )
  })

  it("fails with the tool's output when the tests or the export fail", function () {
    const run = swiftCheck(['--spm', 'Tally', 'Tally'], {}, { fail: 'test' })
    expect(run.code).equals(1)
    expect(run.log).deep.equals([
      'Test run with 3 tests failed',
      'could not read Swift coverage: test failed'
    ])
  })

  it('refuses to guess which report to read', function () {
    for (const argv of [
      ['Tally'],
      ['--spm', 'a', '--xcresult', 'b', 'Tally'],
      ['--spm', 'a', '--derived-data', 'b', 'Tally']
    ]) {
      const run = swiftCheck(argv, {})
      expect(run.code).equals(2)
      expect(run.log[0]).includes('usage:')
      expect(run.calls).deep.equals([])
    }
  })
})
