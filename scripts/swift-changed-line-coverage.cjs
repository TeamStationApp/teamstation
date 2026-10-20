const { execFileSync } = require('node:child_process')
const { mkdtempSync, realpathSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, join, relative, resolve } = require('node:path')

const check = require('./changed-line-check.cjs')
const {
  lcovCounts,
  resolveSpecs,
  xccovCounts
} = require('./changed-line-coverage.cjs')

// The changed-line gate for Swift, reading the coverage Swift writes and
// handing the counts to `changed-line-check.cjs`:
//
//   node scripts/swift-changed-line-coverage.cjs (--spm <package dir> |
//     --xcresult <result bundle> [--derived-data <dir>])
//     [--exclude <path|glob> …] <pathspec> …
//
// `--spm` runs the package's tests with coverage and exports it as lcov.
// `--xcresult` reads an Xcode result bundle with `xccov`, one changed file at
// a time. `xccov` lists the app's own targets but no file of a local Swift
// package, which Xcode builds as its own framework, so `--derived-data` adds
// the run's profile exported with `llvm-cov` from the app and every package
// framework built beside it. Either way the checker is always given
// `--ext .swift`, `--exclude '**/Tests/**'` and `--exclude '**/Package.swift'`:
// Xcode and SwiftPM both report coverage for test sources, and a test is not
// the code it tests; a package manifest is build metadata that no test runs,
// so a new package would otherwise fail on its own manifest.

const USAGE =
  'usage: swift-changed-line-coverage.cjs (--spm <dir> | --xcresult <path> ' +
  '[--derived-data <dir>]) [--export-counts <file>] [--exclude <path>] <pathspec>…'

const ALWAYS = [
  '--ext',
  '.swift',
  '--exclude',
  '**/Tests/**',
  '--exclude',
  '**/Package.swift'
]

function parseArgs(argv) {
  const args = { rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--spm') args.spm = argv[++i]
    else if (arg === '--xcresult') args.xcresult = argv[++i]
    else if (arg === '--derived-data') args.derivedData = argv[++i]
    else if (arg === '--export-counts') {
      args.exportCounts = argv[++i]
      if (args.exportCounts == null || args.exportCounts.startsWith('--'))
        throw new Error('--export-counts needs a file')
    } else args.rest.push(arg)
  }
  if ((args.spm == null) === (args.xcresult == null))
    throw new Error('give one of --spm or --xcresult')
  if (args.derivedData != null && args.xcresult == null)
    throw new Error('--derived-data goes with --xcresult')
  return args
}

// A path with every symlink resolved, or the path itself when it does not
// exist (a file deleted since the build).
function realOrSame(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// A report path as the top level sees it, whether the build recorded the
// path through a symlink (/tmp) or through its real place (/private/tmp),
// and whichever of the two git gave as the top level: the record is matched
// as written and with its symlinks resolved, against both of the top level's.
function topRelative(tops, path) {
  const real = realOrSame(path)
  for (const candidate of real === path ? [path] : [path, real])
    for (const top of tops)
      if (candidate.startsWith(`${top}/`)) return relative(top, candidate)
  return undefined
}

function topLevels(topLevel) {
  const real = realOrSame(topLevel)
  return real === topLevel ? [topLevel] : [topLevel, real]
}

// Counts keyed by top-level path, for `--counts`.
function keyed(tops, counts) {
  const out = {}
  for (const [path, lines] of Object.entries(counts)) {
    const key = topRelative(tops, path)
    if (key != null) out[key] = lines
  }
  return out
}

// `swift test --enable-code-coverage`, then its profile exported as lcov.
function spmCounts(dir, run) {
  const at = ['--package-path', dir]
  run('swift', ['test', '--enable-code-coverage', ...at])
  const codecov = run('swift', ['test', '--show-codecov-path', ...at]).trim()
  const bin = run('swift', ['build', '--show-bin-path', ...at]).trim()
  const name = JSON.parse(
    run('swift', ['package', ...at, 'describe', '--type', 'json'])
  ).name
  const tests = `${name}PackageTests`
  const lcov = run('xcrun', [
    'llvm-cov',
    'export',
    '-format=lcov',
    '-instr-profile',
    join(dirname(codecov), 'default.profdata'),
    join(bin, `${tests}.xctest`, 'Contents', 'MacOS', tests)
  ])
  return lcovCounts(lcov)
}

// The changed Swift files under the pathspecs, from the merge base.
function changedSwift(topLevel, specs, run) {
  const base = run('git', ['merge-base', 'origin/master', 'HEAD']).trim()
  return run('git', [
    '-C',
    topLevel,
    'diff',
    '--name-only',
    `${base}...HEAD`,
    '--',
    ...specs
  ])
    .split('\n')
    .filter(path => path.endsWith('.swift'))
}

// Each changed Swift file's counts out of the result bundle. `xccov` wants
// the path exactly as the build recorded it, so it is looked up in the
// bundle's own file list rather than built from the top level.
function xcresultCounts(xcresult, tops, changed, excluded, run) {
  const recorded = run('xcrun', [
    'xccov',
    'view',
    '--archive',
    '--file-list',
    xcresult
  ])
    .split('\n')
    .filter(path => path !== '')
  const wanted = new Set(changed.filter(path => !excluded(path)))
  const counts = {}
  for (const path of recorded) {
    if (!wanted.has(topRelative(tops, path))) continue
    const json = JSON.parse(
      run('xcrun', [
        'xccov',
        'view',
        '--archive',
        '--json',
        '--file',
        path,
        xcresult
      ])
    )
    Object.assign(counts, xccovCounts(json))
  }
  return counts
}

// The newest profile under a DerivedData directory, exported with `llvm-cov`
// from the app and the package frameworks built beside it.
function derivedDataCounts(dir, run) {
  const newest = run('find', [
    join(dir, 'Build', 'ProfileData'),
    '-name',
    'Coverage.profdata',
    '-exec',
    'stat',
    '-f',
    '%m %N',
    '{}',
    '+'
  ])
    .split('\n')
    .filter(line => line !== '')
    .map(line => {
      const at = line.indexOf(' ')
      return { mtime: Number(line.slice(0, at)), path: line.slice(at + 1) }
    })
    .sort((a, b) => b.mtime - a.mtime)[0]
  if (newest == null) throw new Error(`no Coverage.profdata under ${dir}`)
  const binaries = run('find', [
    join(dir, 'Build', 'Products'),
    '-maxdepth',
    '3',
    '(',
    '-name',
    '*.app',
    '-o',
    '-name',
    '*.framework',
    ')'
  ])
    .split('\n')
    .filter(bundle => bundle !== '')
    .map(bundle => join(bundle, basename(bundle).replace(/\.[^.]+$/, '')))
    // A vendored binary framework (Sentry's) ships for several architectures, which llvm-cov
    // refuses without an -arch, and holds none of this repository's code. What the build compiled
    // here is for the one simulator architecture.
    .filter(
      binary => run('lipo', ['-archs', binary]).trim().split(/\s+/).length === 1
    )
  const [first, ...rest] = binaries
  const lcov = run('xcrun', [
    'llvm-cov',
    'export',
    '-format=lcov',
    '-instr-profile',
    newest.path,
    first,
    ...rest.flatMap(binary => ['-object', binary])
  ])
  return lcovCounts(lcov)
}

// Two sets of counts as one, a line counting as its busier report.
function merged(a, b) {
  const out = { ...a }
  for (const [path, lines] of Object.entries(b)) {
    out[path] = { ...(out[path] ?? {}) }
    for (const [line, count] of Object.entries(lines))
      out[path][line] = Math.max(out[path][line] ?? 0, count)
  }
  return out
}

// Whether a top-level path is one the checker will skip anyway, so `xccov`
// is not asked about it.
function skipper(topLevel, rest, cwd) {
  const excludes = []
  for (let i = 0; i < rest.length; i++)
    if (rest[i] === '--exclude') excludes.push(rest[++i])
  const globs = ['**/Tests/**', ...excludes.filter(x => /[*?]/.test(x))].map(
    check.globPattern
  )
  const paths = resolveSpecs(
    topLevel,
    excludes.filter(x => !/[*?]/.test(x)),
    cwd
  )
  return path =>
    globs.some(glob => glob.test(path)) ||
    paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

function specsOf(rest) {
  const specs = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--exclude') i++
    else if (!rest[i].startsWith('--')) specs.push(rest[i])
  }
  return specs
}

// Runs the gate; returns the exit code. `run(file, args)` returns a
// command's stdout and throws when it fails, as `execFileSync` does.
function main(argv, { run, log, cwd = process.cwd() }) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    log(`${error.message}\n${USAGE}`)
    return 2
  }
  const topLevel = run('git', ['rev-parse', '--show-toplevel']).trim()
  const tops = topLevels(topLevel)
  let counts
  try {
    if (args.spm != null) {
      counts = spmCounts(resolve(cwd, args.spm), run)
    } else {
      const specs = resolveSpecs(topLevel, specsOf(args.rest), cwd)
      counts = xcresultCounts(
        resolve(cwd, args.xcresult),
        tops,
        changedSwift(topLevel, specs, run),
        skipper(topLevel, args.rest, cwd),
        run
      )
      if (args.derivedData != null)
        counts = merged(
          counts,
          derivedDataCounts(resolve(cwd, args.derivedData), run)
        )
    }
  } catch (error) {
    // A failing `swift test` lands here too, and its output says why.
    if (error.stdout)
      log(String(error.stdout).split('\n').slice(-40).join('\n'))
    log(`could not read Swift coverage: ${error.message}`)
    return 1
  }
  const dir = mkdtempSync(join(tmpdir(), 'swift-changed-line-'))
  const file = join(dir, 'counts.json')
  writeFileSync(file, JSON.stringify(keyed(tops, counts)))
  if (args.exportCounts != null)
    writeFileSync(
      resolve(cwd, args.exportCounts),
      JSON.stringify(keyed(tops, counts))
    )
  return check.main(['--counts', file, ...ALWAYS, ...args.rest], {
    run,
    log,
    cwd
  })
}

module.exports = { main, spmCounts }

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), {
    run: (file, args) =>
      execFileSync(file, args, {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit']
      }),
    log: line => {
      console.log(line)
    }
  })
}
