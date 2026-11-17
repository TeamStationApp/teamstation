import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import type { ToolDefinition } from './messagesApi'

export const DIRECTORY_MAP = 'src/DIRECTORY_MAP.md'
export const MAP_FIRST = `Read ${DIRECTORY_MAP} completely first, then use it to choose a source directory or file.`
export const SOURCE_LIMITS = {
  fileBytes: 256 * 1024,
  outputCharacters: 20000,
  lines: 200,
  entries: 200,
  matches: 50,
  scannedBytes: 2 * 1024 * 1024,
  visitedEntries: 2000
} as const

const NAMES = [
  'source_list_directory',
  'source_read_file',
  'source_search'
] as const
type SourceToolName = (typeof NAMES)[number]

export function isSourceTool(name: string): name is SourceToolName {
  return NAMES.some(each => each === name)
}

const pathProperty = {
  type: 'string',
  description:
    'Repository-relative path inside src, such as src/server/tess. Use src for its root.'
}

export const SOURCE_TOOLS: ToolDefinition[] = [
  {
    name: 'source_list_directory',
    description: `Lists immediate files and directories in TeamStation's source, read-only. ${MAP_FIRST} Symbolic links are skipped; large results are limited.`,
    input_schema: {
      type: 'object',
      properties: { path: pathProperty },
      required: ['path']
    }
  },
  {
    name: 'source_read_file',
    description: `Reads numbered lines from TeamStation's open-source code, for any user. Start with ${DIRECTORY_MAP}, then choose relevant files. Reads at most 200 lines and 20,000 characters; use startLine to continue. Files over 256 KiB and binary files are refused. No writes or commands.`,
    input_schema: {
      type: 'object',
      properties: {
        path: pathProperty,
        startLine: {
          type: 'integer',
          minimum: 1,
          description: 'First line, starting at 1; defaults to 1.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'source_search',
    description: `Finds a literal, case-sensitive single-line string in a chosen source file or directory tree. ${MAP_FIRST} Narrow the path using the map; do not blindly search all src. Returns numbered matches with explicit limits. Binary, large and unreadable files and symbolic links are skipped. No regular expressions or commands.`,
    input_schema: {
      type: 'object',
      properties: {
        path: pathProperty,
        text: {
          type: 'string',
          description:
            'Nonempty literal text to find, up to 500 characters on one line.'
        }
      },
      required: ['path', 'text']
    }
  }
]

/** The same release's src, from either src/server/tess or lib/server/tess. */
export function sourceRoot(moduleDirectory = __dirname): string {
  return resolve(moduleDirectory, '../../../src')
}

/**
 * Names under src that are not open source: a host's secrets (src/.gitignore),
 * build output, dependencies and hidden tool state. Refused at any depth.
 */
const PRIVATE_NAMES = new Set([
  'serverConfig.json',
  'clientConfig.json',
  'clientConfig.xcconfig',
  'local.properties',
  'node_modules',
  'lib',
  'dist',
  'build',
  'build-device',
  'build-local',
  'web-build',
  'Pods',
  'DerivedData'
])

export function isPrivateName(name: string): boolean {
  return (
    name.startsWith('.') ||
    PRIVATE_NAMES.has(name) ||
    name.endsWith('.keystore') ||
    name.endsWith('.xcuserdatad')
  )
}

interface SourceResult {
  content: string
  is_error?: boolean
}

interface Budget {
  visited: number
  skipped: number
  limited: boolean
}

/** One response turn's navigation state. Construction does no filesystem I/O. */
export function sourceBrowser(root = sourceRoot()): {
  run: (name: SourceToolName, input: unknown) => Promise<SourceResult>
  acceptMapResult: (result: { content: unknown; is_error?: boolean }) => void
} {
  let mapRead = false
  let completeMap: string | undefined
  let checkedRoot: Promise<string> | undefined

  // Checked once per turn; every path is still checked against it.
  async function rootPath(): Promise<string> {
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error('root')
    return await realpath(root)
  }

  async function checkedPath(path: string): Promise<string> {
    const parts = path.split('/')
    if (
      parts[0] !== 'src' ||
      parts.some(part => part === '..') ||
      /[\\\0]/.test(path)
    )
      throw new Error('path')
    if (checkedRoot == null) {
      checkedRoot = rootPath()
      checkedRoot.catch(() => {
        checkedRoot = undefined
      })
    }
    const canonicalRoot = await checkedRoot
    let target = canonicalRoot
    for (const part of parts.slice(1)) {
      if (part === '' || part === '.') continue
      if (isPrivateName(part)) throw new Error('private')
      target = resolve(target, part)
      if ((await lstat(target)).isSymbolicLink()) throw new Error('link')
    }
    const canonical = await realpath(target)
    if (
      canonical !== canonicalRoot &&
      !canonical.startsWith(canonicalRoot + sep)
    )
      throw new Error('boundary')
    return canonical
  }

  async function textFile(
    path: string,
    scan?: { bytes: number; limited: boolean }
  ): Promise<{ text: string; bytes: number }> {
    const target = await checkedPath(path)
    if (!(await lstat(target)).isFile()) throw new Error('file')
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const stat = await file.stat()
      const current = await lstat(await checkedPath(path))
      if (
        !stat.isFile() ||
        stat.dev !== current.dev ||
        stat.ino !== current.ino ||
        stat.size > SOURCE_LIMITS.fileBytes
      )
        throw new Error('file')
      // A file too large for what is left of the scan is skipped, not read.
      if (scan != null && scan.bytes + stat.size > SOURCE_LIMITS.scannedBytes) {
        scan.limited = true
        throw new Error('scan limit')
      }
      // One byte past the stat'd size shows growth since the stat.
      const buffer = Buffer.alloc(
        Math.min(stat.size, SOURCE_LIMITS.fileBytes) + 1
      )
      let bytes = 0
      for (;;) {
        const read = await file.read(
          buffer,
          bytes,
          buffer.length - bytes,
          bytes
        )
        bytes += read.bytesRead
        if (scan != null) {
          scan.bytes += read.bytesRead
          if (scan.bytes > SOURCE_LIMITS.scannedBytes) {
            scan.limited = true
            throw new Error('scan limit')
          }
        }
        if (bytes > SOURCE_LIMITS.fileBytes) throw new Error('size')
        if (read.bytesRead === 0) break
        if (bytes === buffer.length) throw new Error('changed')
      }
      const data = buffer.subarray(0, bytes)
      if (data.includes(0)) throw new Error('binary')
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(data),
        bytes
      }
    } finally {
      await file.close()
    }
  }

  async function* entries(
    path: string,
    recursive: boolean,
    budget: Budget,
    nested = false
  ): AsyncGenerator<{ path: string; directory: boolean }> {
    let directory
    try {
      directory = await opendir(await checkedPath(path))
    } catch (error) {
      // A subdirectory that cannot be opened is skipped, not the whole search.
      if (!nested) throw error
      budget.skipped += 1
      return
    }
    for await (const entry of directory) {
      budget.visited += 1
      if (budget.visited > SOURCE_LIMITS.visitedEntries) {
        budget.limited = true
        return
      }
      if (!entry.isDirectory() && !entry.isFile()) continue
      if (isPrivateName(entry.name)) continue
      const child = `${path.replace(/\/$/, '')}/${entry.name}`
      yield { path: child, directory: entry.isDirectory() }
      if (recursive && entry.isDirectory())
        yield* entries(child, true, budget, true)
      if (budget.limited) return
    }
  }

  return {
    // The turn loop calls this only after fitting the results for the next request.
    // Reading a file alone must not unlock sibling calls in the same model batch.
    acceptMapResult: result => {
      if (
        completeMap != null &&
        result.content === completeMap &&
        result.is_error !== true
      )
        mapRead = true
    },
    run: async (name, raw) => {
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
        return {
          content: 'Source tools take an object with a src-relative path.',
          is_error: true
        }
      const input = raw as Record<string, unknown>
      if (typeof input.path !== 'string' || input.path.length > 4096)
        return {
          content: 'Supply a src-relative path of at most 4096 characters.',
          is_error: true
        }
      const path = input.path
      if (!mapRead && !(name === 'source_read_file' && path === DIRECTORY_MAP))
        return { content: MAP_FIRST, is_error: true }
      try {
        if (name === 'source_read_file') {
          const start = input.startLine ?? 1
          if (
            typeof start !== 'number' ||
            !Number.isSafeInteger(start) ||
            start < 1
          )
            return {
              content: 'startLine must be a positive integer.',
              is_error: true
            }
          const { text } = await textFile(path)
          const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
          let content = `${path} (${lines.length} lines)\n`
          let next = start - 1
          let clipped = false
          for (
            ;
            next < lines.length && next < start - 1 + SOURCE_LIMITS.lines;
            next += 1
          ) {
            const line = `${next + 1}: ${lines[next]}\n`
            if (
              content.length + line.length >
              SOURCE_LIMITS.outputCharacters - 150
            ) {
              clipped = true
              content += line.slice(
                0,
                Math.max(
                  0,
                  SOURCE_LIMITS.outputCharacters - 150 - content.length
                )
              )
              break
            }
            content += line
          }
          const complete = start === 1 && next >= lines.length && !clipped
          if (clipped)
            content +=
              '\n[Output limited; this line is clipped. Narrow the question with source_search.]'
          else if (next < lines.length)
            content += `[More lines: read again with startLine ${next + 1}.]`
          else if (start > lines.length) content += '[End of file.]'
          if (path === DIRECTORY_MAP && complete) completeMap = content
          return { content }
        }

        const budget = { visited: 0, skipped: 0, limited: false }
        const output: string[] = []
        let size = 0
        const add = (line: string): boolean => {
          if (size + line.length + 1 > SOURCE_LIMITS.outputCharacters - 200) {
            budget.limited = true
            return false
          }
          output.push(line)
          size += line.length + 1
          return true
        }
        if (name === 'source_list_directory') {
          for await (const entry of entries(path, false, budget)) {
            if (
              output.length >= SOURCE_LIMITS.entries ||
              !add(entry.path + (entry.directory ? '/' : ''))
            ) {
              budget.limited = true
              break
            }
          }
          return {
            content:
              output.sort().join('\n') +
              (budget.limited
                ? '\n[Listing limited.]'
                : output.length === 0
                  ? '[Empty directory.]'
                  : '')
          }
        }

        if (
          typeof input.text !== 'string' ||
          input.text.length === 0 ||
          input.text.length > 500 ||
          /[\r\n]/.test(input.text)
        )
          return {
            content:
              'Search text must be a nonempty literal string of at most 500 characters on one line. Search for one line of a multiline fragment, then read the surrounding source.',
            is_error: true
          }
        const stat = await lstat(await checkedPath(path))
        const candidates = stat.isFile()
          ? [{ path, directory: false }]
          : entries(path, true, budget)
        const scan = { bytes: 0, limited: false }
        let skipped = 0
        for await (const entry of candidates) {
          if (entry.directory) continue
          let file: Awaited<ReturnType<typeof textFile>>
          try {
            file = await textFile(entry.path, scan)
          } catch {
            skipped += 1
            continue
          }
          for (const [index, line] of file.text.split('\n').entries()) {
            const match = line.indexOf(input.text)
            if (match < 0) continue
            const offset = Math.max(
              0,
              match - Math.min(80, 500 - input.text.length)
            )
            const snippet = line.slice(offset, offset + 500)
            if (
              output.length >= SOURCE_LIMITS.matches ||
              !add(
                `${entry.path}:${index + 1}: ${snippet}${line.length > 500 ? ' [line clipped]' : ''}`
              )
            ) {
              budget.limited = true
              break
            }
          }
          if (budget.limited) break
        }
        return {
          content:
            (output.length === 0 ? '[No matches.]' : output.join('\n')) +
            `\n[${skipped + budget.skipped} files skipped.]` +
            (budget.limited || scan.limited
              ? '\n[Search limited; choose a narrower path.]'
              : '')
        }
      } catch {
        return {
          content:
            'Source path unavailable or refused. Use a regular UTF-8 file or directory inside src; links, binary files and files over 256 KiB are not readable.',
          is_error: true
        }
      }
    }
  }
}
