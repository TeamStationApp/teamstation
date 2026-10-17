const { relative, resolve } = require('node:path')

// Accounting consumes original-source line counters, never bundle totals.
function changedLines(diff) {
  const files = {}
  let path
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      path = line.slice(6)
      files[path] ??= new Set()
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (path != null && hunk != null) {
      const start = Number(hunk[1])
      const length = hunk[2] == null ? 1 : Number(hunk[2])
      for (let i = 0; i < length; i++) files[path].add(start + i)
    }
  }
  return files
}

// One Istanbul file entry as { line: count }: a line counts as its busiest
// statement, and a line no statement touches is not executable.
function istanbulCounts(entry) {
  const lines = {}
  for (const [id, statement] of Object.entries(entry.statementMap)) {
    for (let n = statement.start.line; n <= statement.end.line; n++)
      lines[n] = Math.max(lines[n] ?? 0, entry.s[id] ?? 0)
  }
  return lines
}

// `xcrun xccov view --archive --json --file <path> <xcresult>` output, as
// { path: { line: count } } over the executable lines.
function xccovCounts(json) {
  const files = {}
  for (const [path, lines] of Object.entries(json)) {
    files[path] = {}
    for (const line of lines)
      if (line.isExecutable) files[path][line.line] = line.executionCount ?? 0
  }
  return files
}

// An lcov report as { path: { line: count } }, from its SF and DA records.
function lcovCounts(text) {
  const files = {}
  let current
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      current = files[line.slice(3)] ??= {}
    } else if (line.startsWith('DA:') && current != null) {
      const [number, count] = line.slice(3).split(',')
      current[Number(number)] = Math.max(
        current[Number(number)] ?? 0,
        Number(count)
      )
    } else if (line === 'end_of_record') current = undefined
  }
  return files
}

// A JaCoCo XML report (Kover writes the same) as { path: { line: count } },
// keyed by each source file's package directory and name
// (`app/example/Thing.kt`), from its `<line nr ci>` records: a line counts as
// its covered instructions.
function jacocoCounts(xml) {
  const files = {}
  const attribute = (attrs, name) =>
    new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]
  for (const [, packageAttrs, body] of xml.matchAll(
    /<package\b([^>]*)>([\s\S]*?)<\/package>/g
  )) {
    const directory = attribute(packageAttrs, 'name') ?? ''
    for (const [, fileAttrs, lines] of body.matchAll(
      /<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g
    )) {
      const name = attribute(fileAttrs, 'name') ?? ''
      const path = directory === '' ? name : `${directory}/${name}`
      const counts = (files[path] ??= {})
      for (const [, lineAttrs] of lines.matchAll(/<line\b([^>]*?)\/?>/g)) {
        const number = Number(attribute(lineAttrs, 'nr'))
        if (!Number.isInteger(number)) continue
        const count = Number(attribute(lineAttrs, 'ci') ?? 0)
        counts[number] = Math.max(counts[number] ?? 0, count)
      }
    }
  }
  return files
}

// Pathspecs as git's top level sees them, wherever the command was run.
function resolveSpecs(topLevel, specs, cwd = process.cwd()) {
  return specs.map(spec => relative(topLevel, resolve(cwd, spec)) || '.')
}

// The gate. `counts` is { path: { line: count } }, with no entry for a file
// that has no coverage record; `executable(path)` says whether such a file
// should have had one. Every added file is held to `newFileMin` on its own,
// as well as the whole to the selected minimum (90 for unit-only gates).
function lineReportFromCounts(
  changes,
  counts,
  executable,
  { newFiles = [], newFileMin = 90, min = 90 } = {}
) {
  const added = new Set(newFiles)
  const files = {}
  const missing = []
  const newFileReport = {}
  let total = 0
  let covered = 0
  for (const [path, changed] of Object.entries(changes)) {
    if (changed.size === 0) continue
    const lines = counts[path]
    if (lines == null) {
      if (executable(path)) missing.push(path)
      continue
    }
    files[path] = { covered: [], uncovered: [] }
    for (const line of changed) {
      if (!(line in lines)) continue
      total++
      if (lines[line] > 0) {
        covered++
        files[path].covered.push(line)
      } else files[path].uncovered.push(line)
    }
    if (added.has(path)) {
      const own = files[path].covered.length + files[path].uncovered.length
      newFileReport[path] =
        own === 0 ? 100 : (100 * files[path].covered.length) / own
    }
  }
  const percent = total === 0 ? 100 : (100 * covered) / total
  const shortNewFiles = Object.entries(newFileReport)
    .filter(([, filePercent]) => filePercent < newFileMin)
    .map(([path]) => path)
  return {
    covered,
    total,
    percent,
    missing,
    files,
    newFiles: newFileReport,
    shortNewFiles,
    pass: missing.length === 0 && percent >= min && shortNewFiles.length === 0
  }
}

function lineReport(changes, coverage, executable) {
  const counts = {}
  for (const [path, entry] of Object.entries(coverage))
    if (entry != null) counts[path] = istanbulCounts(entry)
  return lineReportFromCounts(changes, counts, executable)
}

module.exports = {
  changedLines,
  istanbulCounts,
  jacocoCounts,
  lcovCounts,
  lineReport,
  lineReportFromCounts,
  resolveSpecs,
  xccovCounts
}
