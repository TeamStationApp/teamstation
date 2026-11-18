import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { readBuildInfo } from '../../../common/distribution'
import {
  sourceLines,
  sourcePaths,
  type SourceRole,
  sourceRole,
  sourceText
} from './files'
import { sourceSymbols } from './outline'
import { directoryMapProblem, SCHEMA_VERSION, SOURCE_SCHEMA } from './schema'

/**
 * The commit the About screen shows, read the same way: TS_BUILD_INFO
 * through `readBuildInfo`. An empty, malformed or incomplete value falls
 * through to git, like a missing one.
 */
function buildInfoCommit(): string | undefined {
  try {
    const { commit } = readBuildInfo(process.env.TS_BUILD_INFO?.trim())
    return commit === '' || commit === '—' ? undefined : commit
  } catch {
    return undefined
  }
}

/**
 * Only the root's own checkout names the commit: a tree with no `.git` is
 * never labelled with an enclosing repository's HEAD. Uncommitted edits to
 * tracked source are served, so that commit is marked `-dirty`.
 */
export function sourceCommit(root: string): string {
  const fromBuild = buildInfoCommit()
  if (fromBuild != null) return fromBuild
  if (!existsSync(join(root, '.git'))) return 'unknown'
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  try {
    const head = git('rev-parse', 'HEAD')
    const dirty =
      git('status', '--porcelain', '--untracked-files=no', '--', 'src') !== ''
    return dirty ? `${head}-dirty` : head
  } catch {
    return 'unknown'
  }
}

/** SQLite's side files; a journal left by a killed build would be replayed. */
function removeDatabase(path: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm'])
    rmSync(`${path}${suffix}`, { force: true })
}

/** A failed build cannot replace the last usable release index. */
export function buildSourceIndex(options: {
  root: string
  out: string
  commit?: string
}): {
  files: number
  roles: Record<SourceRole, number>
  skipped: Array<{ path: string; reason: string }>
  symbols: number
  bytes: number
  milliseconds: number
  commit: string
} {
  const started = performance.now()
  const root = resolve(options.root)
  const out = resolve(options.out)
  const temp = `${out}.tmp`
  mkdirSync(dirname(out), { recursive: true })
  removeDatabase(temp)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(temp)
    db.exec(SOURCE_SCHEMA)
    db.exec('BEGIN')
    const insertFile = db.prepare(
      'INSERT INTO files(path,directory,role,lines,bytes,content) VALUES(?,?,?,?,?,?)'
    )
    const insertEntry = db.prepare(
      'INSERT OR IGNORE INTO entries(parent,name,kind) VALUES(?,?,?)'
    )
    const insertSymbol = db.prepare(
      'INSERT INTO symbols(path,name,kind,line,end_line,signature,doc) VALUES(?,?,?,?,?,?,?)'
    )
    const roles: Record<SourceRole, number> = { code: 0, test: 0, fixture: 0 }
    const skipped: Array<{ path: string; reason: string }> = []
    let files = 0
    let symbols = 0
    let hasMap = false
    for (const path of sourcePaths(root)) {
      const text = sourceText(root, path)
      if ('reason' in text) {
        skipped.push({ path, reason: text.reason })
        continue
      }
      const role = sourceRole(path)
      insertFile.run(
        path,
        posix.dirname(path),
        role,
        sourceLines(text.content).length,
        text.bytes,
        text.content
      )
      files += 1
      roles[role] += 1
      if (path === 'src/DIRECTORY_MAP.md') {
        // The server refuses a map it cannot put in the prompt, so the build does too.
        const problem = directoryMapProblem(text.content)
        if (problem != null) throw new Error(problem)
        hasMap = true
      }
      let entry = path
      let kind = 'file'
      while (entry !== 'src') {
        insertEntry.run(posix.dirname(entry), posix.basename(entry), kind)
        entry = posix.dirname(entry)
        kind = 'directory'
      }
      for (const symbol of sourceSymbols(path, text.content)) {
        insertSymbol.run(
          path,
          symbol.name,
          symbol.kind,
          symbol.line,
          symbol.endLine,
          symbol.signature,
          symbol.doc
        )
        symbols += 1
      }
    }
    if (files === 0 || !hasMap)
      throw new Error('Source index needs source text and src/DIRECTORY_MAP.md')
    const commit = options.commit ?? sourceCommit(root)
    const meta = db.prepare('INSERT INTO meta(key,value) VALUES(?,?)')
    for (const [key, value] of Object.entries({
      schema_version: String(SCHEMA_VERSION),
      commit,
      built_at: new Date().toISOString(),
      files: String(files),
      skipped: JSON.stringify(skipped)
    }))
      meta.run(key, value)
    db.exec("INSERT INTO search(search) VALUES('rebuild'); COMMIT; VACUUM;")
    db.close()
    db = undefined
    renameSync(temp, out)
    return {
      files,
      roles,
      skipped,
      symbols,
      bytes: statSync(out).size,
      milliseconds: Math.round(performance.now() - started),
      commit
    }
  } finally {
    db?.close()
    removeDatabase(temp)
  }
}
