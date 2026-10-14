const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const {
  changedLines,
  istanbulCounts,
  jacocoCounts,
  lineReportFromCounts,
  resolveSpecs
} = require('./changed-line-coverage.cjs')

// The changed-line coverage gate every milestone runs:
//
//   node scripts/changed-line-check.cjs (--coverage <coverage-final.json> |
//     --counts <json> | --jacoco <report.xml> --source-root <dir> …)
//     --ext <.x> [--ext …] [--exclude <path|glob> …] [--allow-empty]
//     <pathspec> …
//
// `--jacoco` reads a JaCoCo XML report, which names each file by its package
// directory; `--source-root` says which directories those are relative to, so
// `<root>/app/example/Thing.kt` is the report's `app/example/Thing.kt`.
//
// The lines are those this branch changed under the pathspecs, from
// `git merge-base origin/master HEAD` to HEAD. A changed file is executable
// when its extension is one of `--ext`, it is no `*.test.*`,
// `*.integration.*` or `*.e2e.*`,
// and no `--exclude` matches it. The gate fails when covered changed lines
// are under 90%, when an added file covers under 90% of its own lines, when
// an executable changed file has no coverage record, and when nothing under
// the pathspecs changed, unless `--allow-empty`.

const USAGE =
  'usage: changed-line-check.cjs (--coverage <file> | --counts <file> | ' +
  '--jacoco <file> --source-root <dir>…) --ext <.x> [--exclude <path>] ' +
  '[--allow-empty] <pathspec>…'

function parseArgs(argv) {
  const args = {
    exts: [],
    excludes: [],
    sourceRoots: [],
    specs: [],
    allowEmpty: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--coverage') args.coverage = argv[++i]
    else if (arg === '--counts') args.counts = argv[++i]
    else if (arg === '--jacoco') args.jacoco = argv[++i]
    else if (arg === '--source-root') args.sourceRoots.push(argv[++i])
    else if (arg === '--ext') args.exts.push(argv[++i])
    else if (arg === '--exclude') args.excludes.push(argv[++i])
    else if (arg === '--allow-empty') args.allowEmpty = true
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else args.specs.push(arg)
  }
  const reports = [args.coverage, args.counts, args.jacoco]
  if (reports.filter(report => report != null).length !== 1)
    throw new Error('give one of --coverage, --counts or --jacoco')
  if ((args.jacoco == null) !== (args.sourceRoots.length === 0))
    throw new Error('--source-root goes with --jacoco, which needs one')
  if (args.exts.length === 0) throw new Error('give at least one --ext')
  if (
    args.exts.some(ext => ext == null) ||
    args.excludes.some(x => x == null) ||
    args.sourceRoots.some(x => x == null)
  )
    throw new Error('an option is missing its value')
  return args
}

// A glob, where `**` crosses directories and `*` does not, as a RegExp.
function globPattern(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

// Whether a top-level path is excluded: by a glob, or by a path that is the
// file itself or a directory above it.
function excluder(topLevel, excludes, cwd) {
  const globs = excludes.filter(x => /[*?]/.test(x)).map(globPattern)
  const paths = resolveSpecs(
    topLevel,
    excludes.filter(x => !/[*?]/.test(x)),
    cwd
  )
  return path =>
    globs.some(glob => glob.test(path)) ||
    paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

function executableFile(path, exts) {
  return (
    exts.some(ext => path.endsWith(ext)) &&
    !/\.(test|integration|e2e)\.[^/]+$/.test(path)
  )
}

// Line counts keyed by top-level path, from any of the reports.
function countsFor(args, topLevel, paths, cwd) {
  const counts = {}
  if (args.jacoco != null) {
    const raw = jacocoCounts(readFileSync(resolve(cwd, args.jacoco), 'utf8'))
    const roots = resolveSpecs(topLevel, args.sourceRoots, cwd)
    for (const path of paths) {
      const root = roots.find(root => path.startsWith(`${root}/`))
      const entry = root == null ? undefined : raw[path.slice(root.length + 1)]
      if (entry != null) counts[path] = entry
    }
  } else if (args.coverage != null) {
    const raw = JSON.parse(readFileSync(resolve(cwd, args.coverage), 'utf8'))
    for (const path of paths) {
      const entry = raw[join(topLevel, path)] ?? raw[path]
      if (entry != null) counts[path] = istanbulCounts(entry)
    }
  } else {
    const raw = JSON.parse(readFileSync(resolve(cwd, args.counts), 'utf8'))
    for (const path of paths) {
      const entry = raw[join(topLevel, path)] ?? raw[path]
      if (entry != null) counts[path] = entry
    }
  }
  return counts
}

// Whether a repository-relative path lies under one of the pathspecs, which
// `resolveSpecs` has already made repository-relative.
function underSpecs(specs) {
  const roots = specs.map(spec => spec.replace(/\/+$/, ''))
  return path =>
    roots.some(
      root => root === '.' || path === root || path.startsWith(`${root}/`)
    )
}

// Runs the gate; returns the exit code. `run(file, args)` returns a
// command's stdout, so a test can hand it canned git output.
function main(argv, { run, log, cwd = process.cwd() }) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    log(`${error.message}\n${USAGE}`)
    return 2
  }
  const topLevel = run('git', ['rev-parse', '--show-toplevel']).trim()
  const base = run('git', ['merge-base', 'origin/master', 'HEAD']).trim()
  const specs = resolveSpecs(topLevel, args.specs, cwd)
  const range = `${base}...HEAD`
  // The whole tree is diffed and the pathspecs applied afterwards: git pairs a
  // rename only when it can see both sides, so a pathspec that names just the
  // new location would report a moved file as added, every line of it new.
  const within = underSpecs(specs)
  const diff = run('git', [
    '-C',
    topLevel,
    'diff',
    '--unified=0',
    '--find-renames',
    range
  ])
  const added = run('git', [
    '-C',
    topLevel,
    'diff',
    '--name-only',
    '--find-renames',
    '--diff-filter=A',
    range
  ])
    .split('\n')
    .filter(path => path !== '' && within(path))
  const all = Object.fromEntries(
    Object.entries(changedLines(diff)).filter(([path]) => within(path))
  )
  if (Object.keys(all).length === 0) {
    log(`nothing changed under ${specs.join(' ')} since ${base}`)
    return args.allowEmpty ? 0 : 1
  }
  const excluded = excluder(topLevel, args.excludes, cwd)
  const changes = {}
  for (const [path, lines] of Object.entries(all))
    if (executableFile(path, args.exts) && !excluded(path))
      changes[path] = lines
  const counts = countsFor(args, topLevel, Object.keys(changes), cwd)
  const report = lineReportFromCounts(changes, counts, () => true, {
    newFiles: added,
    newFileMin: 90
  })
  for (const [path, rows] of Object.entries(report.files)) {
    const total = rows.covered.length + rows.uncovered.length
    if (total === 0) continue
    const percent = ((100 * rows.covered.length) / total).toFixed(1)
    const tag = path in report.newFiles ? ' (new)' : ''
    log(`  ${path}${tag}: ${percent}% (${rows.covered.length}/${total})`)
    if (rows.uncovered.length > 0)
      log(`    uncovered: ${rows.uncovered.join(',')}`)
  }
  for (const path of report.missing) log(`  ${path}: no coverage record`)
  for (const path of report.shortNewFiles)
    log(`  ${path}: a new file under 90% on its own`)
  log(
    `Changed executable line coverage: ${report.covered}/${report.total} ` +
      `(${report.percent.toFixed(2)}%)${report.pass ? '' : ' FAILED'}`
  )
  return report.pass ? 0 : 1
}

module.exports = { executableFile, globPattern, main, underSpecs }

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), {
    run: (file, args) =>
      execFileSync(file, args, {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024
      }),
    log: line => {
      console.log(line)
    }
  })
}
