const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const {
  istanbulCounts,
  lcovCounts,
  jacocoCounts
} = require('./changed-line-coverage.cjs')

const digest = path =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

/** Combine measured hits only when every report names the exact source snapshot. */
function auditCoverage(snapshot, reports, minimum = 95) {
  if (reports.length === 0) throw new Error('No measured coverage reports')
  const counts = {}
  for (const report of reports) {
    if (report.head !== snapshot.head || report.base !== snapshot.base)
      throw new Error('Coverage revision does not match')
    if (!Number.isInteger(report.tests) || report.tests < 1)
      throw new Error('Empty or unverified test suite')
    for (const [file, lines] of Object.entries(report.counts)) {
      if (!(file in snapshot.files)) continue
      if (report.hashes[file] !== snapshot.files[file].hash)
        throw new Error(`Stale source coverage: ${file}`)
      if (Object.keys(lines).length === 0)
        throw new Error(`Missing executable source map: ${file}`)
      const merged = (counts[file] ??= {})
      for (const [line, hits] of Object.entries(lines)) {
        if (!/^[1-9][0-9]*$/.test(line) || !Number.isFinite(hits) || hits < 0)
          throw new Error(`Invalid measured counter: ${file}:${line}`)
        merged[line] = Math.max(merged[line] ?? 0, hits)
      }
    }
  }
  const files = {}
  let covered = 0
  let total = 0
  for (const [file, source] of Object.entries(snapshot.files)) {
    const measured = counts[file]
    if (measured == null) throw new Error(`Missing instrumentation: ${file}`)
    const scope = source.added
      ? Object.keys(measured).map(Number)
      : source.lines
    const executable = scope.filter(line => line in measured)
    const uncovered = executable.filter(line => measured[line] === 0)
    const ownTotal = executable.length
    const ownCovered = ownTotal - uncovered.length
    covered += ownCovered
    total += ownTotal
    files[file] = {
      covered: ownCovered,
      total: ownTotal,
      percent: ownTotal === 0 ? 100 : (100 * ownCovered) / ownTotal,
      uncovered
    }
  }
  if (total === 0) throw new Error('Empty executable coverage scope')
  const percent = (100 * covered) / total
  return {
    base: snapshot.base,
    head: snapshot.head,
    covered,
    total,
    percent,
    files,
    pass:
      percent >= minimum &&
      Object.values(files).every(file => file.percent >= minimum)
  }
}

/** Readers preserve original line numbers; callers normalize paths to the checkout. */
function readCounters(format, content) {
  if (format === 'istanbul')
    return Object.fromEntries(
      Object.entries(JSON.parse(content)).map(([file, entry]) => [
        file,
        istanbulCounts(entry)
      ])
    )
  if (format === 'lcov') return lcovCounts(content)
  if (format === 'jacoco') return jacocoCounts(content)
  throw new Error(`Unknown coverage format: ${format}`)
}

/** A completed failing Swift suite still produces useful measured counters. */
function swiftTestResult(name, status, output) {
  const summary = /Test run with (\d+) tests?[^\n]* (passed|failed) after/.exec(
    output
  )
  const tests = Number(summary?.[1] ?? 0)
  if (
    tests < 1 ||
    !(
      (status === 0 && summary[2] === 'passed') ||
      (status === 1 && summary[2] === 'failed')
    )
  )
    throw new Error(
      `${name} host tests did not complete: ${output.slice(-6000)}`
    )
  const failed = [
    ...output.matchAll(/^✘ Test (?!run with )(.+?) failed after/gm)
  ].map(match => `${name}: ${match[1]}`)
  return {
    tests,
    failures:
      status === 0
        ? []
        : failed.length > 0
          ? failed
          : [`${name}: host test run failed`]
  }
}

module.exports = { auditCoverage, digest, readCounters, swiftTestResult }
