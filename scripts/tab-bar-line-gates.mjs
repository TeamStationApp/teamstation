import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import lines from './changed-line-coverage.cjs'
import { coverageSource } from './coverage-source.mjs'
import gate from './observability-line-gate.cjs'

export const jsIncludes = [
  'src/app/**',
  'e2e/rigs/refinementsMaestro.ts',
  'src/server/tess/sitemapGenerator.ts'
]
const jsRoots = ['src/app', ...jsIncludes.slice(1)]
// The lockfile pins dependencies. Some worktrees symlink their install.
export const sourceStamp = () => coverageSource(['.', ':(exclude)node_modules'])
export const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

export function jsCounts(report, root = process.cwd()) {
  const counts = {}
  for (const [file, entry] of Object.entries(report)) {
    const path = relative(root, resolve(root, file))
    if (jsRoots.some(scope => path === scope || path.startsWith(scope + '/')))
      counts[path] = lines.istanbulCounts(entry)
  }
  return counts
}

/** Direct TypeScript loads execute the checkout. Prebuilt JS must prove its originals. */
export function verifyNodeSources(counts, records) {
  const pending = new Set(Object.keys(counts))
  for (const record of records) {
    for (const script of record.result) {
      if (!script.url.startsWith('file:')) continue
      const generated = fileURLToPath(script.url)
      pending.delete(relative(process.cwd(), generated))
      const map = record['source-map-cache']?.[script.url]?.data
      for (const [i, name] of (map?.sources ?? []).entries()) {
        const absolute = name.startsWith('file:')
          ? fileURLToPath(name)
          : resolve(dirname(generated), map.sourceRoot ?? '', name)
        const file = relative(process.cwd(), absolute)
        if (!Object.hasOwn(counts, file)) continue
        if (
          absolute !== generated &&
          map.sourcesContent?.[i] !== readFileSync(absolute, 'utf8')
        )
          throw new Error(
            'Stale or missing compiled source content for ' + file
          )
        pending.delete(file)
      }
    }
  }
  if (pending.size)
    throw new Error('Unverified V8 source paths: ' + [...pending].join(', '))
}

export function measured(kind, source, counts) {
  if (
    !['js', 'native'].includes(kind) ||
    !Object.values(counts).some(lines => Object.keys(lines).length > 0)
  )
    throw new Error('No measured tab-bar coverage counters for ' + kind)
  for (const [file, lines] of Object.entries(counts)) {
    if (
      file !== relative(process.cwd(), resolve(file)) ||
      file.startsWith('../')
    )
      throw new Error('Expected a repository-relative coverage path')
    for (const [line, hits] of Object.entries(lines)) {
      if (!/^[1-9]\d*$/.test(line) || !Number.isSafeInteger(hits) || hits < 0)
        throw new Error('Invalid measured line counter for ' + file)
    }
  }
  return { schema: 'tab-bar-line-counts-v1', kind, source, counts }
}

export function combinedCounts(kind, source, unit, supplements) {
  const inputs = [unit]
  for (const report of supplements) {
    if (report.schema !== 'tab-bar-line-counts-v1' || report.source !== source)
      throw new Error(
        'Coverage counters belong to a different source revision or format'
      )
    measured(report.kind, report.source, report.counts)
    if (report.kind === kind) inputs.push(report.counts)
  }
  return gate.mergeCounts(...inputs)
}

export function coverageGates(kind, source, unit, supplements) {
  return [
    [90, unit],
    [95, combinedCounts(kind, source, unit, supplements)]
  ]
}

export function runGates(kind, source, unit, supplements, base, directory) {
  if (source !== sourceStamp())
    throw new Error('Source changed during coverage measurement')
  const native = kind === 'native'
  const prefix = native ? 'native-' : ''
  const scope = native
    ? ['--ext', '.mm', 'ios/TeamStation']
    : [
        '--ext',
        '.ts',
        '--ext',
        '.tsx',
        '--exclude',
        'src/app/theme/types.ts', // Theme interfaces have no runtime instructions.
        ...jsRoots
      ]
  for (const [minimum, counts] of coverageGates(
    kind,
    source,
    unit,
    supplements
  )) {
    const path = join(
      directory,
      minimum === 90 && native
        ? 'native-counts.json'
        : prefix +
            (minimum === 90 ? 'unit-counts.json' : 'combined-counts.json')
    )
    writeFileSync(path, JSON.stringify(counts))
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./changed-line-check.cjs', import.meta.url)),
        '--base',
        base,
        '--counts',
        path,
        '--min',
        String(minimum),
        '--report',
        join(directory, prefix + 'changed-lines-' + minimum + '.json'),
        ...scope
      ],
      { stdio: 'inherit' }
    )
  }
}
