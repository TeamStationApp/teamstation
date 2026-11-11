// Merge measured counters, never percentages. Each report needs a provenance sidecar
// written by `record` around the test command, before any source changes.
// record <sidecar.json> <unit|integration|device> <istanbul|lcov|jacoco|counts>
//   <report> <source-root> -- <test command> [args...]
// gate <sidecar.json>... [--base <integration ref>]
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import coverage from './changed-line-coverage.cjs'
import provenance from './coverage-provenance.cjs'

const digest = text => createHash('sha256').update(text).digest('hex')

export function mergeReports(source, reports, root = process.cwd()) {
  const counts = {}
  const unit = {}
  for (const report of reports) {
    if (!isDeepStrictEqual(report.source, source))
      throw new Error('Coverage revision mismatch')
    if (!['unit', 'integration', 'device'].includes(report.kind))
      throw new Error('Unknown coverage test kind')
    let raw
    const text = readFileSync(report.file, 'utf8')
    if (report.digest != null && report.digest !== digest(text))
      throw new Error('Coverage report changed after measurement')
    switch (report.format) {
      case 'istanbul':
        raw = Object.fromEntries(
          Object.entries(JSON.parse(text)).map(([file, entry]) => [
            file,
            coverage.istanbulCounts(entry)
          ])
        )
        break
      case 'lcov':
        raw = coverage.lcovCounts(text)
        break
      case 'jacoco':
        raw = coverage.jacocoCounts(text)
        break
      case 'counts':
        {
          const measured = JSON.parse(text)
          if (
            report.digest == null ||
            !isDeepStrictEqual(measured.source, source) ||
            !Array.isArray(measured.command) ||
            measured.command.length === 0 ||
            !measured.command.every(part => typeof part === 'string')
          )
            throw new Error('Normalized counts require measurement provenance')
          raw = measured.counts
        }
        break
      default:
        throw new Error('Unknown coverage format')
    }
    for (const [file, lines] of Object.entries(raw)) {
      const name = relative(root, resolve(report.sourceRoot, file))
      if (name.startsWith('../')) continue
      // Bundlers may report a virtual entry module. It has no source types to
      // remove, and it is outside the git-derived production change set.
      const filtered = existsSync(resolve(root, name))
        ? coverage.withoutTypeOnlyLines(
            name,
            readFileSync(resolve(root, name), 'utf8'),
            lines
          )
        : lines
      for (const [line, hits] of Object.entries(filtered)) {
        if (!Number.isFinite(hits) || hits < 0 || !/^\d+$/.test(line))
          throw new Error('Invalid measured counter')
        const target = (counts[name] ??= {})
        target[line] = (target[line] ?? 0) + hits
        if (report.kind === 'unit') {
          const target = (unit[name] ??= {})
          target[line] = (target[line] ?? 0) + hits
        }
      }
    }
  }
  return { counts, unit }
}

export function evaluate(changes, counts, newFiles, min) {
  return coverage.lineReportFromCounts(changes, counts, () => true, {
    newFiles,
    min,
    perFileMin: min,
    newFileMin: min
  })
}

export function coverageArguments(argv) {
  const boundary = argv.indexOf('--')
  const options = boundary < 0 ? argv : argv.slice(0, boundary)
  const baseIndex = options.indexOf('--base')
  if (baseIndex < 0) return { base: 'origin/develop', args: [...argv] }
  const base = options[baseIndex + 1]
  if (base == null || base.startsWith('--'))
    throw new Error('--base requires a ref')
  return {
    base,
    args: [...argv.slice(0, baseIndex), ...argv.slice(baseIndex + 2)]
  }
}

export function main(argv) {
  const { base, args } = coverageArguments(argv)
  const root = process.cwd()
  const source = provenance.coverageSource(root, base)
  if (args[0] === 'record') {
    const [, sidecar, kind, format, file, sourceRoot, separator, ...command] =
      args
    if (separator !== '--' || command.length === 0)
      throw new Error('record needs metadata followed by -- and a test command')
    rmSync(sidecar, { force: true })
    rmSync(file, { force: true })
    const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' })
    if (result.error != null) throw result.error
    if (result.status !== 0) throw new Error('Coverage test command failed')
    provenance.verifyCoverageSource(source, root, base)
    // Reading now also rejects a missing output instead of leaving a valid-looking sidecar.
    let measured = readFileSync(file, 'utf8')
    if (format === 'counts') {
      // Normalized counters must retain the source and the successful producing command.
      // As with LCOV/XML, the exporter is trusted; a JSON file alone is not measurement proof.
      measured = JSON.stringify({
        source,
        command,
        counts: JSON.parse(measured)
      })
      writeFileSync(file, measured)
    }
    writeFileSync(
      sidecar,
      JSON.stringify(
        {
          source,
          kind,
          format,
          file: resolve(file),
          sourceRoot: resolve(sourceRoot),
          digest: digest(measured)
        },
        null,
        2
      )
    )
    return
  }
  if (args[0] !== 'gate' || args.length < 2)
    throw new Error('Use record or gate with at least one measured report')
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).trim()
  const fork = git('merge-base', base, 'HEAD')
  const changed = coverage.changedLines(
    git('diff', '--unified=0', fork, 'HEAD')
  )
  const production = file =>
    /\.(swift|kt|mm|ts|tsx)$/.test(file) &&
    !/\/Tests\/|\/test\/|\/androidTest\/|\.(test|e2e|integration)\.|Package\.swift$/.test(
      file
    )
  const changes = Object.fromEntries(
    Object.entries(changed).filter(([file]) => production(file))
  )
  const newFiles = git(
    'diff',
    '--name-only',
    '--diff-filter=A',
    fork,
    'HEAD'
  ).split('\n')
  const reports = args
    .slice(1)
    .map(file => JSON.parse(readFileSync(file, 'utf8')))
  const { counts, unit } = mergeReports(source, reports, root)
  const combined = evaluate(changes, counts, newFiles, 95)
  const units = evaluate(changes, unit, newFiles, 90)
  console.log(JSON.stringify({ source, combined, unit: units }, null, 2))
  if (!combined.pass || !units.pass)
    throw new Error(
      'Coverage gate failed: unit 90%, combined 95% per file and overall; missing instrumentation fails'
    )
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2))
