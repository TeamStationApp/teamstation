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

// Token ranges come from the parser, including contextual template/regex tokens.
function forEachSourceToken(ts, parsed, work) {
  const visit = node => {
    if (
      node.kind >= ts.SyntaxKind.FirstJSDocNode &&
      node.kind <= ts.SyntaxKind.LastJSDocNode
    )
      return
    const children = node.getChildren(parsed)
    if (children.length > 0) children.forEach(visit)
    else if (node.getEnd() > node.getStart(parsed)) work(node)
  }
  visit(parsed)
}

// Structural punctuation and plain parameter bindings do not execute alone.
function nonExecutingToken(ts, node, keepBindings = false) {
  // A plain parameter binding has no independent executable expression.
  // Defaults, rest allocation and destructuring retain their runtime tokens.
  if (
    !keepBindings &&
    ts.isIdentifier(node) &&
    ts.isParameter(node.parent) &&
    node.parent.name === node &&
    node.parent.initializer == null &&
    node.parent.dotDotDotToken == null
  )
    return true
  if (node.kind === ts.SyntaxKind.OpenBraceToken)
    return !ts.isObjectLiteralExpression(node.parent)
  if (node.kind === ts.SyntaxKind.OpenBracketToken)
    return !ts.isArrayLiteralExpression(node.parent)
  return [
    ts.SyntaxKind.OpenParenToken,
    ts.SyntaxKind.ColonToken,
    ts.SyntaxKind.CloseBraceToken,
    ts.SyntaxKind.CloseBracketToken,
    ts.SyntaxKind.CloseParenToken,
    ts.SyntaxKind.CommaToken,
    ts.SyntaxKind.SemicolonToken
  ].includes(node.kind)
}

// Mapping boundary segments can point into whitespace or past an expression.
// Only actual non-delimiter tokens may contribute an execution count.
function executionTokens(path, source) {
  const ts = require('typescript')
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const mask = new Uint8Array(source.length)
  const ownerAt = new Uint32Array(source.length)
  const owners = [{ start: 0, end: source.length, body: 0 }]
  const ownerIds = new Map()
  forEachSourceToken(ts, parsed, node => {
    if (nonExecutingToken(ts, node, true)) return
    const start = node.getStart(parsed)
    const end = node.getEnd()
    mask.fill(1, start, end)
    let owner = node.parent
    while (owner != null && !(ts.isFunctionLike(owner) && owner.body != null))
      owner = owner.parent
    if (owner != null) {
      let id = ownerIds.get(owner)
      if (id == null) {
        id = owners.length
        ownerIds.set(owner, id)
        owners.push({
          start: owner.getStart(parsed),
          end: owner.end,
          body: owner.body.getStart(parsed)
        })
      }
      ownerAt.fill(id, start, end)
    }
  })
  return {
    mask,
    ownerAt,
    owners,
    starts: parsed.getLineStarts(),
    indents: source.split('\n').map(line => line.search(/\S/))
  }
}

// Remove a line only when its non-trivia tokens all belong to selected syntax.
// Mixed runtime/type lines and parse failures retain their original counters.
function withoutNodeLines(path, source, counts, erased) {
  const ts = require('typescript')
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  if (parsed.parseDiagnostics.length !== 0) return counts
  const ranges = []
  const visit = node => {
    if (erased(ts, node)) {
      ranges.push([node.getStart(parsed), node.end])
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  const lines = new Map()
  forEachSourceToken(ts, parsed, node => {
    const start = node.getStart(parsed)
    const end = node.getEnd()
    const typeOnly = ranges.some(([from, to]) => from <= start && end <= to)
    // A separator beside an erased specifier does not make that line execute.
    if (!typeOnly && nonExecutingToken(ts, node)) return
    const first = parsed.getLineAndCharacterOfPosition(start).line + 1
    const last = parsed.getLineAndCharacterOfPosition(end - 1).line + 1
    for (let line = first; line <= last; line++) {
      const flags = lines.get(line) ?? { erased: false, runtime: false }
      flags[typeOnly ? 'erased' : 'runtime'] = true
      lines.set(line, flags)
    }
  })
  return Object.fromEntries(
    Object.entries(counts).filter(([number]) => {
      const flags = lines.get(Number(number))
      return flags == null || !flags.erased || flags.runtime
    })
  )
}

// Type-only imports/exports and their individual specifiers are erased too.
function withoutTypeOnlyLines(path, source, counts) {
  if (!/\.[cm]?tsx?$/.test(path)) return counts
  return withoutNodeLines(
    path,
    source,
    counts,
    (ts, node) =>
      (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      (ts.isPropertyDeclaration(node) &&
        node.initializer == null &&
        !ts.isComputedPropertyName(node.name) &&
        (ts.getDecorators(node)?.length ?? 0) === 0) ||
      (ts.isImportDeclaration(node) &&
        node.importClause?.isTypeOnly === true) ||
      ((ts.isImportEqualsDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isExportDeclaration(node) ||
        ts.isExportSpecifier(node)) &&
        node.isTypeOnly === true)
  )
}

// Static module linkage is not an executable statement in this module's body.
// The imported module's executed code has its own source counters.
function withoutModuleDeclarationLines(path, source, counts) {
  return withoutNodeLines(
    path,
    source,
    counts,
    (ts, node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
  )
}

// Required lines come from source, independently of any coverage report.
function executableLines(path, source) {
  const lines = Object.fromEntries(
    source.split('\n').map((_, index) => [index + 1, 0])
  )
  const executable = withoutModuleDeclarationLines(
    path,
    source,
    withoutTypeOnlyLines(path, source, withoutTriviaLines(path, source, lines))
  )
  return new Set(Object.keys(executable).map(Number))
}

// V8 source conversion also emits counters for trivia. Keep only source tokens.
function withoutTriviaLines(path, source, counts) {
  const ts = require('typescript')
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const tokenLines = new Set()
  forEachSourceToken(ts, parsed, node => {
    if (nonExecutingToken(ts, node) || node.flags & ts.NodeFlags.Ambient) return
    const first =
      parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
    const last =
      parsed.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1
    for (let line = first; line <= last; line++) tokenLines.add(line)
  })
  return Object.fromEntries(
    Object.entries(counts).filter(([line]) => tokenLines.has(Number(line)))
  )
}

// Every scored line needs a real mapping and V8 counter, including zero counts.
function mappedV8LineCounts(source, map, scripts, required, options = {}) {
  const { SourceMap } = require('node:module')
  const sourceMap = new SourceMap(map)
  const generated = executionTokens('generated.js', source)
  const originals = Object.fromEntries(
    map.sources.map((file, index) => [
      file,
      executionTokens(file, map.sourcesContent[index])
    ])
  )
  const counts = Object.fromEntries(
    Object.keys(required).map(file => [file, {}])
  )
  // Each script's candidate ranges for one owning function, found once.
  const ownerRanges = scripts.map(() => new Map())
  const rangesOf = (index, id) => {
    const cached = ownerRanges[index].get(id)
    if (cached != null) return cached
    const script = scripts[index]
    const owner = generated.owners[id]
    const fn = script.functions.find(fn => {
      const root = fn.ranges[0]
      return (
        root.startOffset >= owner.start &&
        root.startOffset <= owner.body &&
        root.endOffset === owner.end
      )
    })
    const ranges =
      fn?.ranges ??
      script.functions
        .flatMap(fn => fn.ranges)
        .filter(
          range =>
            range.count === 0 &&
            range.startOffset <= owner.body &&
            range.endOffset >= owner.end
        )
    ownerRanges[index].set(id, ranges)
    return ranges
  }
  let offset = 0
  for (const [line, text] of source.split('\n').entries()) {
    for (let column = 0; column < text.length; column++) {
      if (!generated.mask[offset + column]) continue
      const entry = sourceMap.findEntry(line, column)
      const originalLine = entry.originalLine + 1
      const wanted = required[entry.originalSource]
      const original = originals[entry.originalSource]
      // Sucrase may map a whole line to its leading indentation. Resolve
      // that prefix to its first token; never move an end-of-line boundary.
      const originalColumn = Math.max(
        entry.originalColumn,
        original?.indents[entry.originalLine] ?? -1
      )
      if (
        entry.generatedLine !== line ||
        wanted == null ||
        !wanted.has(originalLine) ||
        (options.linePreserving
          ? entry.originalLine !== line
          : original?.mask[
              original.starts[entry.originalLine] + originalColumn
            ] !== 1)
      )
        continue
      const point = offset + column
      for (const index of scripts.keys()) {
        // Require this token's own function record. Lazy nested functions
        // may be absent only when an explicit enclosing zero range proves
        // their whole body did not run. A positive wrapper is insufficient.
        const ranges = rangesOf(index, generated.ownerAt[point])
        if (ranges.length === 0)
          throw new Error(
            `Mapped V8 owning-function counter missing for ${entry.originalSource}:${originalLine}`
          )
        const range = ranges
          .filter(r => r.startOffset <= point && point < r.endOffset)
          .sort(
            (a, b) =>
              a.endOffset - a.startOffset - (b.endOffset - b.startOffset)
          )[0]
        if (range != null && Number.isFinite(range.count) && range.count >= 0)
          counts[entry.originalSource][originalLine] = Math.max(
            counts[entry.originalSource][originalLine] ?? 0,
            range.count
          )
      }
    }
    offset += text.length + 1
  }
  for (const [file, lines] of Object.entries(required))
    for (const line of lines)
      if (counts[file][line] == null)
        throw new Error(`Mapped V8 counter missing for ${file}:${line}`)
  return counts
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
  { newFiles = [], newFileMin = 90, min = 90, perFileMin } = {}
) {
  const added = new Set(newFiles)
  const files = {}
  const missing = []
  const newFileReport = {}
  const shortFiles = []
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
      const own = Object.values(lines)
      newFileReport[path] =
        own.length === 0
          ? 100
          : (100 * own.filter(count => count > 0).length) / own.length
    }
    const ownChanged = files[path].covered.length + files[path].uncovered.length
    if (
      perFileMin != null &&
      ownChanged > 0 &&
      (100 * files[path].covered.length) / ownChanged < perFileMin
    )
      shortFiles.push(path)
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
    shortFiles,
    pass:
      missing.length === 0 &&
      percent >= min &&
      shortNewFiles.length === 0 &&
      shortFiles.length === 0
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
  executableLines,
  istanbulCounts,
  jacocoCounts,
  lcovCounts,
  lineReport,
  lineReportFromCounts,
  mappedV8LineCounts,
  withoutModuleDeclarationLines,
  resolveSpecs,
  withoutTriviaLines,
  withoutTypeOnlyLines,
  xccovCounts
}
