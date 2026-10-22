// Capture source before a fresh llvm-cov run, then bind its measured LCOV
// counters to those exact files. This tool does not infer executable lines.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { isAbsolute, relative, resolve } = require('node:path')
const { isDeepStrictEqual } = require('node:util')

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const inside = path =>
  path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path)

function sourceState(root, sources) {
  root = realpathSync(root)
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.some(path => !inside(path))
  )
    throw new Error('Explicit repository-relative source paths required')
  const paths = [
    ...new Set(
      git(root, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...sources
      ])
        .split('\0')
        .filter(Boolean)
    )
  ].sort()
  if (paths.length === 0) throw new Error('No source files found')
  const files = Object.fromEntries(
    paths.map(path => {
      const full = realpathSync(resolve(root, path))
      if (!inside(relative(root, full)))
        throw new Error('Source outside repository')
      return [path, hash(readFileSync(full))]
    })
  )
  return { root, revision: git(root, ['rev-parse', 'HEAD']), sources, files }
}

function snapshot(root, sources) {
  return {
    schema: 'llvm-source-v1',
    ...sourceState(root, sources),
    capturedAt: Date.now()
  }
}

function verifySnapshot(manifest, root) {
  if (
    manifest?.schema !== 'llvm-source-v1' ||
    !Number.isSafeInteger(manifest.capturedAt) ||
    manifest.capturedAt <= 0
  )
    throw new Error('Invalid LLVM source manifest')
  const { schema, capturedAt, ...expected } = manifest
  if (!isDeepStrictEqual(expected, sourceState(root, manifest.sources)))
    throw new Error('LLVM coverage source changed after snapshot')
}

function measuredCounts(text, manifest) {
  const counts = {}
  let path, lines, found, hit, length
  const finish = () => {
    if (
      path == null ||
      found == null ||
      hit == null ||
      found !== Object.keys(lines).length ||
      hit !== Object.values(lines).filter(n => n > 0).length
    )
      throw new Error('Incomplete or inconsistent LLVM line record')
    const kept = (counts[path] ??= {})
    for (const [line, count] of Object.entries(lines))
      kept[line] = Math.max(kept[line] ?? 0, count)
    path = undefined
  }
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('SF:')) {
      if (path != null) throw new Error('Unterminated LLVM record')
      const full = realpathSync(resolve(manifest.root, raw.slice(3)))
      path = relative(manifest.root, full)
      if (!inside(path) || !Object.hasOwn(manifest.files, path))
        throw new Error('Unmapped LLVM source file')
      length = readFileSync(full, 'utf8').split('\n').length
      lines = {}
      found = undefined
      hit = undefined
    } else if (raw.startsWith('DA:')) {
      const row = /^DA:([1-9][0-9]*),([0-9]+)(?:,[^,]+)?$/.exec(raw)
      if (path == null || row == null)
        throw new Error('Invalid LLVM line counter')
      const line = Number(row[1])
      const count = Number(row[2])
      if (
        !Number.isSafeInteger(line) ||
        !Number.isSafeInteger(count) ||
        line > length ||
        Object.hasOwn(lines, line)
      )
        throw new Error('Invalid or duplicate LLVM line counter')
      lines[line] = count
    } else if (raw.startsWith('LF:') || raw.startsWith('LH:')) {
      if (path == null || !/^(LF|LH):[0-9]+$/.test(raw))
        throw new Error('Invalid LLVM line totals')
      const number = Number(raw.slice(3))
      if (!Number.isSafeInteger(number))
        throw new Error('Invalid LLVM line totals')
      if (raw.startsWith('LF:')) {
        if (found != null) throw new Error('Duplicate LLVM line total')
        found = number
      } else {
        if (hit != null) throw new Error('Duplicate LLVM line total')
        hit = number
      }
    } else if (raw === 'end_of_record') finish()
    else if (raw !== '' && !/^(TN|FN|FNDA|FNF|FNH|BRDA|BRF|BRH):/.test(raw))
      throw new Error('Unrecognized LLVM coverage record')
  }
  if (path != null) throw new Error('Unterminated LLVM record')
  if (Object.values(counts).every(lines => Object.keys(lines).length === 0))
    throw new Error('LLVM report has no measured executable lines')
  return counts
}

function convert(manifest, lcov, root = manifest.root) {
  verifySnapshot(manifest, root)
  if (statSync(lcov).mtimeMs < manifest.capturedAt)
    throw new Error('LLVM report predates source snapshot')
  const bytes = readFileSync(lcov)
  const counts = measuredCounts(bytes.toString('utf8'), manifest)
  verifySnapshot(manifest, root)
  return {
    schema: 'llvm-line-counts-v1',
    source: manifest,
    lcov: resolve(lcov),
    lcovSha256: hash(bytes),
    counts
  }
}

function validateCounts(envelope, root) {
  if (envelope?.schema !== 'llvm-line-counts-v1')
    throw new Error('Invalid LLVM counts envelope')
  const current = convert(envelope.source, envelope.lcov, root)
  if (!isDeepStrictEqual(current, envelope))
    throw new Error('LLVM coverage report or counters changed')
  return current.counts
}

function main(argv) {
  const args = { source: [] }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2)
    const value = argv[i + 1]
    if (
      !['root', 'source', 'snapshot', 'manifest', 'lcov', 'out'].includes(
        key
      ) ||
      value == null ||
      value.startsWith('--')
    )
      throw new Error(
        'Expected --snapshot FILE --root DIR --source PATH… or --manifest FILE --lcov FILE --out FILE'
      )
    if (key === 'source') args.source.push(value)
    else args[key] = value
  }
  let output, result
  if (
    args.snapshot != null &&
    args.root != null &&
    args.manifest == null &&
    args.lcov == null &&
    args.out == null
  ) {
    output = args.snapshot
    result = snapshot(args.root, args.source)
  } else if (
    args.manifest != null &&
    args.lcov != null &&
    args.out != null &&
    args.snapshot == null &&
    args.source.length === 0
  ) {
    output = args.out
    result = convert(
      JSON.parse(readFileSync(args.manifest, 'utf8')),
      args.lcov,
      args.root
    )
  } else
    throw new Error('Choose one complete LLVM snapshot or conversion command')
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
}

module.exports = {
  snapshot,
  verifySnapshot,
  measuredCounts,
  convert,
  validateCounts,
  main
}
if (require.main === module) main(process.argv.slice(2))
