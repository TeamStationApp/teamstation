// Accounting consumes original-source Istanbul counters, never bundle totals.
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
function lineReport(changes, coverage, executable) {
  const files = {}
  const missing = []
  let total = 0
  let covered = 0
  for (const [path, changed] of Object.entries(changes)) {
    if (changed.size === 0) continue
    const entry = coverage[path]
    if (entry == null) {
      if (executable(path)) missing.push(path)
      continue
    }
    const lines = {}
    for (const [id, statement] of Object.entries(entry.statementMap)) {
      for (let n = statement.start.line; n <= statement.end.line; n++)
        lines[n] = Math.max(lines[n] ?? 0, entry.s[id] ?? 0)
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
  }
  const percent = total === 0 ? 100 : (100 * covered) / total
  return {
    covered,
    total,
    percent,
    missing,
    files,
    pass: missing.length === 0 && percent >= 90
  }
}
module.exports = { changedLines, lineReport }
