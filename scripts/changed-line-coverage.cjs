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

// Pathspecs as git's top level sees them, wherever the command was run.
function resolveSpecs(topLevel, specs, cwd = process.cwd()) {
  return specs.map(spec => relative(topLevel, resolve(cwd, spec)) || '.')
}

// The gate. `counts` is { path: { line: count } }, with no entry for a file
// that has no coverage record; `executable(path)` says whether such a file
// should have had one. Every added file is held to `newFileMin` on its own,
// as well as the whole to 90.
function lineReportFromCounts(
  changes,
  counts,
  executable,
  { newFiles = [], newFileMin = 90 } = {}
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
    pass: missing.length === 0 && percent >= 90 && shortNewFiles.length === 0
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
  lcovCounts,
  lineReport,
  lineReportFromCounts,
  resolveSpecs,
  xccovCounts
}
