import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync
} from 'node:fs'
import { basename, join, posix } from 'node:path'

export const MAX_SOURCE_BYTES = 1024 * 1024
export type SourceRole = 'code' | 'test' | 'fixture'

export function sourceRole(path: string): SourceRole {
  if (/\.(?:test|spec|integration|e2e)\./.test(basename(path))) return 'test'
  if (
    path.startsWith('src/test/') ||
    path
      .split('/')
      .slice(0, -1)
      .some(part =>
        ['fixture', 'fixtures', 'reference', '__snapshots__'].includes(part)
      )
  )
    return 'fixture'
  return 'code'
}

/**
 * Names that never ship as source: a host's secrets, build output,
 * dependencies and hidden tool state. Case-folded for case-insensitive disks.
 */
const PRIVATE_NAMES = new Set([
  'serverconfig.json',
  'clientconfig.json',
  'clientconfig.xcconfig',
  'local.properties',
  'node_modules',
  'lib',
  'dist',
  'build',
  'build-device',
  'build-local',
  'web-build',
  'pods',
  'deriveddata'
])

export function isPrivateName(name: string): boolean {
  const folded = name.toLowerCase()
  return (
    folded.startsWith('.') ||
    PRIVATE_NAMES.has(folded) ||
    folded.endsWith('.keystore') ||
    folded.endsWith('.xcuserdatad')
  )
}

/** The literal paths `.gitattributes` marks export-ignore, when it is present. */
function exportIgnored(root: string): string[] {
  let text: string
  try {
    text = readFileSync(join(root, '.gitattributes'), 'utf8')
  } catch {
    return []
  }
  return text.split('\n').flatMap(line => {
    const [pattern, ...attributes] = line.trim().split(/\s+/)
    return pattern != null &&
      !pattern.startsWith('#') &&
      attributes.includes('export-ignore') &&
      !/[*?[\]!]/.test(pattern)
      ? [pattern.replace(/^\/+|\/+$/g, '')]
      : []
  })
}

/** Include directories in attribute queries: export-ignore is not inherited. */
export function sourcePaths(root: string): string[] {
  if (existsSync(join(root, '.git'))) {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'src'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
      .split('\0')
      .filter(Boolean)
    if (tracked.length === 0) return []
    const paths = new Set<string>()
    for (const file of tracked) {
      let path = file
      while (path !== '.') {
        paths.add(path)
        path = posix.dirname(path)
      }
    }
    const attributes = execFileSync(
      'git',
      ['check-attr', '-z', 'export-ignore', '--stdin'],
      {
        cwd: root,
        input: [...paths].join('\0') + '\0',
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
      }
    ).split('\0')
    const ignored = new Set<string>()
    for (let i = 0; i + 2 < attributes.length; i += 3)
      if (attributes[i + 2] === 'set') ignored.add(attributes[i])
    return tracked
      .filter(file => {
        let path = file
        while (path !== '.') {
          if (ignored.has(path)) return false
          path = posix.dirname(path)
        }
        return true
      })
      .sort()
  }
  // Without git, the tree is normally a `git archive` release. A copied
  // checkout is not, so its secrets, build output and export-ignored paths
  // are still kept out.
  const ignored = exportIgnored(root)
  const paths: string[] = []
  const walk = (path: string): void => {
    if (
      ignored.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
    )
      return
    const stat = lstatSync(join(root, path))
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      paths.push(path)
      return
    }
    for (const name of readdirSync(join(root, path)))
      if (!isPrivateName(name)) walk(`${path}/${name}`)
  }
  walk('src')
  return paths.sort()
}

export type SourceText = { content: string; bytes: number } | { reason: string }

/** The build reads only regular UTF-8 files and never follows a source link. */
export function sourceText(root: string, path: string): SourceText {
  let fd: number | undefined
  try {
    let parent = path
    while (parent !== '.') {
      if (lstatSync(join(root, parent)).isSymbolicLink())
        return { reason: 'symbolic link' }
      parent = posix.dirname(parent)
    }
    if (!lstatSync(join(root, path)).isFile())
      return { reason: 'not a regular file' }
    fd = openSync(
      join(root, path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { reason: 'not a regular file' }
    if (stat.size > MAX_SOURCE_BYTES) return { reason: 'over 1 MiB' }
    const buffer = Buffer.alloc(stat.size + 1)
    let bytes = 0
    for (;;) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, null)
      if (read === 0) break
      bytes += read
      if (bytes === buffer.length) return { reason: 'changed during build' }
    }
    if (bytes !== stat.size) return { reason: 'changed during build' }
    const data = buffer.subarray(0, bytes)
    if (data.includes(0)) return { reason: 'binary (NUL)' }
    try {
      return {
        content: new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true
        }).decode(data),
        bytes
      }
    } catch {
      return { reason: 'invalid UTF-8' }
    }
  } catch {
    return { reason: 'unreadable' }
  } finally {
    if (fd != null) closeSync(fd)
  }
}

/** A terminating newline ends the previous line; it does not add an empty one. */
export function sourceLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
