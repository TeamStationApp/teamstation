import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import type { ToolDefinition } from './messagesApi'
import { sourceLines } from './sourceIndex/files'
import { directoryMapProblem, SCHEMA_VERSION } from './sourceIndex/schema'

export const DIRECTORY_MAP = 'src/DIRECTORY_MAP.md'
export const SOURCE_UNAVAILABLE = 'Source index unavailable on this server.'
export const SOURCE_QUERY_FAILED =
  'That source call failed; try a narrower or different call.'
export const SOURCE_LIMITS = {
  outputCharacters: 20000,
  lines: 200,
  entries: 200,
  matches: 50
} as const
const NAMES = [
  'source_list_directory',
  'source_read_file',
  'source_search',
  'source_outline',
  'source_find_definition'
] as const
export type SourceToolName = (typeof NAMES)[number]
export function isSourceTool(name: string): name is SourceToolName {
  return NAMES.some(each => each === name)
}

const pathProperty = {
  type: 'string',
  description:
    'Literal repository-relative file or directory inside src, or src for the root.'
}
const includeTests = {
  type: 'boolean',
  description:
    'Include test and fixture files. Use for intended behavior, guarantees, edge cases and whether behavior is tested.'
}
const startEntry = {
  type: 'integer',
  minimum: 1,
  description: 'First entry, starting at 1; defaults to 1.'
}
export const SOURCE_TOOLS: ToolDefinition[] = [
  {
    name: 'source_list_directory',
    description:
      'Lists indexed files and directories in name order, all roles. Read-only, 200 entries per page; use startEntry to continue.',
    input_schema: {
      type: 'object',
      properties: { path: pathProperty, startEntry },
      required: ['path']
    }
  },
  {
    name: 'source_read_file',
    description:
      'Reads numbered lines of indexed public source for any user. At most 200 lines and 20,000 characters; use startLine to continue. No writes or commands.',
    input_schema: {
      type: 'object',
      properties: {
        path: pathProperty,
        startLine: {
          ...startEntry,
          description: 'First line, starting at 1; defaults to 1.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'source_search',
    description:
      'Finds a literal case-sensitive single-line string in an indexed file or subtree, code only by default. Returns up to 50 matching lines. Use the cached directory map to narrow the path. No regular expressions or commands.',
    input_schema: {
      type: 'object',
      properties: {
        path: pathProperty,
        text: {
          type: 'string',
          minLength: 3,
          maxLength: 500,
          description: 'Literal text, 3 to 500 Unicode characters on one line.'
        },
        includeTests
      },
      required: ['path', 'text']
    }
  },
  {
    name: 'source_outline',
    description:
      'Outlines exported symbols in a file or recursively in a folder, code only by default. An explicit test file is included. Pages of 200, with paths, line spans and declaration signatures.',
    input_schema: {
      type: 'object',
      properties: { path: pathProperty, startEntry, includeTests },
      required: ['path']
    }
  },
  {
    name: 'source_find_definition',
    description:
      'Finds exported definitions by exact name, code only by default. Returns up to 50 definitions with paths, lines, signatures and documentation.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 500 },
        includeTests
      },
      required: ['name']
    }
  }
]

export interface SourceResult {
  content: string
  is_error?: boolean
}
export interface SourceIndex {
  readonly prompt: string
  run: (name: SourceToolName, input: unknown) => SourceResult
}
interface FileRow {
  id: number
  path: string
  content: string
  role: string
}
interface SymbolRow {
  path: string
  name: string
  kind: string
  line: number
  end_line: number
  signature: string
  doc: string | null
}

/** Same path from both the TypeScript and compiled server modules. */
export function sourceIndexPath(moduleDirectory = __dirname): string {
  return resolve(moduleDirectory, '../../../lib/server/tess/source.db')
}

/** Escape literal GLOB data, including paths, never SQL syntax. */
export function sourceGlob(text: string): string {
  return text.replace(/[[?*]/g, character =>
    character === '[' ? '[[]' : `[${character}]`
  )
}
/** One literal trigram also accelerates punctuation-only GLOB patterns. */
export function sourceTrigram(text: string): string {
  return `"${Array.from(text).slice(0, 3).join('').replace(/"/g, '""')}"`
}

class InputError extends Error {}
const fail = (content: string): SourceResult => ({ content, is_error: true })
const indexes = new Map<string, SourceIndex>()
const missingWarned = new Set<string>()
const BUDGET = SOURCE_LIMITS.outputCharacters - 512
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>()

/** Each handle prepares a statement once, whatever the call. */
function query(db: DatabaseSync, sql: string): StatementSync {
  let prepared = statements.get(db)
  if (prepared == null) statements.set(db, (prepared = new Map()))
  let statement = prepared.get(sql)
  if (statement == null) prepared.set(sql, (statement = db.prepare(sql)))
  return statement
}

/**
 * Cache the read-only handle, or a failure to open it, for this process's
 * lifetime. A missing file is not cached, so a dev server picks up an index
 * built after it started; a later query error fails only that call.
 */
export function openSourceIndex(path = sourceIndexPath()): SourceIndex {
  const cached = indexes.get(path)
  if (cached != null) return cached
  if (!existsSync(path)) {
    if (!missingWarned.has(path))
      console.warn(
        'Tess source index missing; build it with npm run tess.source-index -- build',
        { path }
      )
    missingWarned.add(path)
    return {
      prompt: SOURCE_UNAVAILABLE,
      run: () => fail(SOURCE_UNAVAILABLE)
    }
  }
  let db: DatabaseSync | undefined
  let warned = false
  const unavailable = (error: unknown): void => {
    if (!warned)
      console.warn('Tess source index unavailable', {
        path,
        reason: error instanceof Error ? error.message : String(error)
      })
    warned = true
    db?.close()
    db = undefined
  }
  let prompt = SOURCE_UNAVAILABLE
  try {
    db = new DatabaseSync(path, { readOnly: true })
    if (
      db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')
        ?.value !== String(SCHEMA_VERSION)
    )
      throw new Error('Unsupported source schema')
    const commit = db
      .prepare('SELECT value FROM meta WHERE key=?')
      .get('commit')?.value
    const map = db
      .prepare('SELECT content FROM files WHERE path=?')
      .get(DIRECTORY_MAP)?.content
    if (typeof commit !== 'string' || typeof map !== 'string')
      throw new Error('Missing commit or compact directory map')
    const problem = directoryMapProblem(map)
    if (problem != null) throw new Error(problem)
    // Reject incomplete indexes at open, even when the first request only needs the map.
    db.prepare('SELECT parent,name,kind FROM entries LIMIT 0').all()
    db.prepare(
      'SELECT path,name,kind,line,end_line,signature,doc FROM symbols LIMIT 0'
    ).all()
    db.prepare('SELECT rowid FROM search WHERE search MATCH ? LIMIT 0').all(
      '"abc"'
    )
    prompt = `## TeamStation source at commit ${commit}\n${map}`
  } catch (error) {
    unavailable(error)
  }
  const index: SourceIndex = {
    prompt,
    run: (name, value) => {
      if (db == null) return fail(SOURCE_UNAVAILABLE)
      try {
        return { content: querySource(db, name, value) }
      } catch (error) {
        if (error instanceof InputError) return fail(error.message)
        console.warn('Tess source query failed', {
          path,
          tool: name,
          reason: error instanceof Error ? error.message : String(error)
        })
        return fail(SOURCE_QUERY_FAILED)
      }
    }
  }
  indexes.set(path, index)
  return index
}

function inputOf(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Supply a source tool input object.')
  const input = value as Record<string, unknown>
  if (input.includeTests != null && typeof input.includeTests !== 'boolean')
    throw new InputError('includeTests must be true or false.')
  return input
}
function first(input: Record<string, unknown>, key: string): number {
  const value = input[key] ?? 1
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new InputError(`${key} must be a positive integer.`)
  return value
}
function checkedPath(input: Record<string, unknown>): string {
  const path = input.path
  if (
    typeof path !== 'string' ||
    path.length > 4096 ||
    !(path === 'src' || path.startsWith('src/')) ||
    path.includes('..') ||
    /[\\\0]/.test(path)
  )
    throw new InputError(
      'Give a literal path in src without parent traversal, backslashes or NUL.'
    )
  return path.replace(/\/+$/, '')
}
function fileAt(db: DatabaseSync, path: string): FileRow | undefined {
  return query(db, 'SELECT id,path,content,role FROM files WHERE path=?').get(
    path
  ) as unknown as FileRow | undefined
}
function isFile(db: DatabaseSync, path: string): boolean {
  return query(db, 'SELECT 1 FROM files WHERE path=?').get(path) != null
}
function knownPath(db: DatabaseSync, path: string): boolean {
  return (
    query(
      db,
      'SELECT 1 FROM files WHERE path=? UNION ALL SELECT 1 FROM entries WHERE parent=? LIMIT 1'
    ).get(path, path) != null
  )
}
/** Beyond this many, the hint says "or more" rather than counting every file. */
const HINT_COUNT = 100
const subtree = '(f.path = ? OR f.path GLOB ?)'
const scope = (path: string): string[] => [path, `${sourceGlob(path)}/*`]
function omittedHint(n: number): string {
  if (n === 0) return ''
  const count = n >= HINT_COUNT ? `${HINT_COUNT} or more` : String(n)
  return `\n[${count} test or fixture files also match; search again with includeTests.]`
}

function readLines(file: FileRow, start: number): string {
  const lines = sourceLines(file.content)
  if (start > lines.length) return '[End of file.]'
  const output: string[] = []
  let length = 0
  let at = start - 1
  for (; at < lines.length && at < start - 1 + SOURCE_LIMITS.lines; at++) {
    const line = `${at + 1}: ${lines[at].replace(/\r$/, '')}`
    if (length + line.length + 1 > BUDGET) {
      if (output.length === 0) {
        output.push(
          line.slice(0, BUDGET - 60),
          '[Line clipped; the rest of this line is omitted.]'
        )
        at++
      }
      break
    }
    output.push(line)
    length += line.length + 1
  }
  if (at < lines.length)
    output.push(`[More lines: read again with startLine ${at + 1}.]`)
  return output.join('\n')
}
function symbolText(row: SymbolRow, definition: boolean): string {
  const span = definition ? `${row.line}` : `${row.line}-${row.end_line}`
  const doc =
    definition && row.doc != null ? ` — ${row.doc.split('\n')[0]}` : ''
  return `${row.path}:${span} ${row.kind} ${row.name.slice(0, 500)} — ${row.signature}${doc}`.slice(
    0,
    BUDGET - 1
  )
}

function querySource(
  db: DatabaseSync,
  name: SourceToolName,
  value: unknown
): string {
  const input = inputOf(value)
  const all = input.includeTests === true
  if (name === 'source_find_definition') {
    if (
      typeof input.name !== 'string' ||
      input.name.length === 0 ||
      input.name.length > 500 ||
      /[\r\n\0]/.test(input.name)
    )
      throw new InputError(
        'Give an exact definition name, up to 500 characters on one line.'
      )
    const rows = query(
      db,
      `SELECT s.* FROM symbols s JOIN files f USING(path) WHERE s.name=? ${all ? '' : "AND f.role='code'"} ORDER BY s.path,s.line LIMIT 51`
    ).all(input.name) as unknown as SymbolRow[]
    const lines: string[] = []
    let size = 0
    for (const row of rows.slice(0, SOURCE_LIMITS.matches)) {
      const line = symbolText(row, true)
      if (size + line.length + 1 > BUDGET) break
      lines.push(line)
      size += line.length + 1
    }
    // Tests are hinted only when no code defines the name.
    const n =
      all || rows.length > 0
        ? 0
        : Number(
            query(
              db,
              `SELECT count(*) AS n FROM (SELECT DISTINCT f.path FROM symbols s JOIN files f USING(path) WHERE s.name=? AND f.role!='code' LIMIT ${HINT_COUNT})`
            ).get(input.name)!.n
          )
    if (lines.length === 0) lines.push(`[No definition named ${input.name}.]`)
    if (rows.length > lines.length)
      lines.push(
        '[Definitions limited; use an outline of the relevant folder.]'
      )
    return lines.join('\n') + omittedHint(n)
  }
  const path = checkedPath(input)
  if (name === 'source_read_file') {
    const file = fileAt(db, path)
    if (file != null) return readLines(file, first(input, 'startLine'))
    throw new InputError(
      knownPath(db, path)
        ? 'That indexed path is a directory, not a file.'
        : 'No indexed file or directory at that path.'
    )
  }
  if (!knownPath(db, path))
    throw new InputError('No indexed file or directory at that path.')
  if (name === 'source_list_directory') {
    if (isFile(db, path))
      throw new InputError('That indexed path is a file, not a directory.')
    const start = first(input, 'startEntry')
    const rows = query(
      db,
      'SELECT name,kind FROM entries WHERE parent=? ORDER BY name LIMIT 201 OFFSET ?'
    ).all(path, start - 1)
    const lines: string[] = []
    let size = 0
    for (const row of rows.slice(0, SOURCE_LIMITS.entries)) {
      const line = String(row.name) + (row.kind === 'directory' ? '/' : '')
      if (size + line.length + 1 > BUDGET) break
      lines.push(line)
      size += line.length + 1
    }
    const next = start + lines.length
    if (rows.length > lines.length)
      lines.push(`[More entries: list again with startEntry ${next}.]`)
    return lines.length === 0 ? '[Empty directory.]' : lines.join('\n')
  }
  if (name === 'source_outline') {
    const start = first(input, 'startEntry')
    const explicitFile = isFile(db, path)
    const rows = query(
      db,
      `SELECT s.* FROM symbols s JOIN files f USING(path) WHERE ${subtree} ${all || explicitFile ? '' : "AND f.role='code'"} ORDER BY s.path,s.line,s.name LIMIT 201 OFFSET ?`
    ).all(...scope(path), start - 1) as unknown as SymbolRow[]
    const lines: string[] = []
    let size = 0
    for (const row of rows.slice(0, SOURCE_LIMITS.entries)) {
      const line = symbolText(row, false)
      if (size + line.length + 1 > BUDGET) break
      lines.push(line)
      size += line.length + 1
    }
    const next = start + lines.length
    if (rows.length > lines.length)
      lines.push(`[More symbols: outline again with startEntry ${next}.]`)
    return lines.length === 0 ? '[No exported symbols.]' : lines.join('\n')
  }
  const text = input.text
  if (
    typeof text !== 'string' ||
    Array.from(text).length < 3 ||
    Array.from(text).length > 500 ||
    /[\r\n\0]/.test(text)
  )
    throw new InputError(
      'Search text must be literal, 3 to 500 Unicode characters on one line, without NUL.'
    )
  const match = sourceTrigram(text)
  const glob = `*${sourceGlob(text)}*`
  const where = `search MATCH ? AND search.content GLOB ? AND ${subtree}`
  const parameters = [match, glob, ...scope(path)]
  // The build inserts files in path order, so rowid order is path order and
  // the walk stops at the match limit without sorting every candidate.
  const ids = query(
    db,
    `SELECT f.id,f.path FROM search JOIN files f ON f.id=search.rowid WHERE ${where} ${all ? '' : "AND f.role='code'"} ORDER BY search.rowid`
  ).iterate(...parameters)
  const content = query(db, 'SELECT content FROM files WHERE id=?')
  const lines: string[] = []
  let size = 0
  let limited = false
  for (const row of ids) {
    const fileText = content.get(row.id)!.content as string
    for (const [at, line] of sourceLines(fileText).entries()) {
      const position = line.indexOf(text)
      if (position < 0) continue
      // Limited only when a match is left out, not when the 50th is the last.
      if (lines.length === SOURCE_LIMITS.matches) {
        limited = true
        break
      }
      const from = Math.max(0, position - 80)
      const snippet = `${from > 0 ? '…' : ''}${line.slice(from, from + 500)}${line.length > from + 500 ? '…' : ''}`
      const result = `${String(row.path)}:${at + 1}: ${snippet}`
      if (size + result.length + 1 > BUDGET) {
        limited = true
        break
      }
      lines.push(result)
      size += result.length + 1
    }
    if (limited) break
  }
  const n = all
    ? 0
    : Number(
        query(
          db,
          `SELECT count(*) AS n FROM (SELECT 1 FROM search JOIN files f ON f.id=search.rowid WHERE ${where} AND f.role!='code' LIMIT ${HINT_COUNT})`
        ).get(...parameters)!.n
      )
  if (lines.length === 0) lines.push('[No matches.]')
  if (limited) lines.push('[Search limited; choose a narrower path.]')
  return lines.join('\n') + omittedHint(n)
}
