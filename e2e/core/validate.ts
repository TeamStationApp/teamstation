import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { migrations } from '../../src/migrate/migrations'
import { faultProblems } from '../faults/catalogue'
import { capabilityProblems } from './capabilities'
import { dumpProblems, type PgTool } from './dumps'
import { globToRegExp } from './glob'
import { readGoldenSuite } from './goldens'
import { type LegacyReport, legacyReport, readLegacy } from './legacy'
import { lintFile } from './lint'
import {
  buildManifest,
  loadSpec,
  renderManifest,
  ROOT,
  testFiles
} from './manifest'
import { moduleOf, moduleProblems } from './modules'
import { OLD_SERVICES, SERVICES, specProblems } from './spec'

export interface ValidationReport extends LegacyReport {
  problems: string[]
}

export function trackedFiles(root = ROOT): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  )
    .trim()
    .split('\n')
    .filter(Boolean)
}

/** Every framework and test file the lint applies to. */
function lintedFiles(tracked: string[], strict: boolean): string[] {
  return tracked.filter(
    file =>
      /^e2e\/(?:tests|core)\/.*\.tsx?$/.test(file) ||
      (strict && /^e2e\/(?:rigs|fixtures)\/.*\.tsx?$/.test(file))
  )
}

/** Every fault each category's specs name. */
function namedFaults(root: string): Record<string, string[]> {
  const named: Record<string, string[]> = {}
  for (const file of testFiles(root)) {
    const spec = loadSpec(file, root)
    const category = spec.id.split('/')[0]
    named[category] = [...(named[category] ?? []), ...spec.faults]
  }
  return named
}

/** A spec's needs outside `specProblems`: its capabilities and its services. */
export function needProblems(spec: {
  surfaces: Parameters<typeof capabilityProblems>[0]['surfaces']
  services: string[]
}): string[] {
  const problems = capabilityProblems(spec)
  const known: readonly string[] = [...SERVICES, ...OLD_SERVICES]
  for (const service of spec.services) {
    if (!known.includes(service)) problems.push(`unknown service "${service}"`)
  }
  return problems
}

export function validate(
  root = ROOT,
  options: { strict?: boolean; pg?: PgTool } = {}
): ValidationReport {
  const strict = options.strict === true
  const problems: string[] = []
  const tracked = trackedFiles(root)
  const fresh = renderManifest(buildManifest(root))
  let stored = ''
  try {
    stored = readFileSync(join(root, 'e2e', 'manifest.json'), 'utf8')
  } catch {
    stored = ''
  }
  if (stored !== fresh) {
    problems.push('e2e/manifest.json is stale: run `e2e manifest`')
  }
  for (const file of testFiles(root)) {
    const spec = loadSpec(file, root)
    for (const problem of [...specProblems(spec), ...needProblems(spec)]) {
      problems.push(`${file}: ${problem}`)
    }
    for (const glob of spec.covers) {
      const pattern = globToRegExp(glob)
      if (!tracked.some(path => pattern.test(path))) {
        problems.push(`${file}: covers "${glob}" matches no file`)
      }
    }
  }
  for (const file of lintedFiles(tracked, strict)) {
    // The lint's own patterns would match themselves.
    if (/\.test\.tsx?$/.test(file) || file === 'e2e/core/lint.ts') continue
    const text = readFileSync(join(root, file), 'utf8')
    for (const problem of lintFile(file, text)) {
      problems.push(`${problem.file}: ${problem.rule}: ${problem.detail}`)
    }
  }
  const legacyList = readLegacy(root)
  problems.push(
    ...faultProblems(namedFaults(root), legacyList.pendingCategories ?? [])
  )
  const report = legacyReport(legacyList, tracked)
  problems.push(...moduleProblems(legacyList, root))
  if (legacyList.modules != null) {
    for (const file of report.additions) {
      const found = moduleOf(file, root)
      if (found != null && legacyList.modules[file] == null) {
        problems.push(`${file}: a non-helper addition has no module`)
      }
    }
  }
  try {
    readGoldenSuite(root)
  } catch (error) {
    problems.push((error as Error).message)
  }
  if (strict) {
    for (const file of [...report.legacy, ...report.additions]) {
      problems.push(`${file}: tests belong under e2e/`)
    }
    problems.push(
      ...dumpProblems(
        root,
        tracked,
        migrations.map(migration => migration.name),
        { ...(options.pg == null ? {} : { pg: options.pg }) }
      )
    )
  }
  return { problems, ...report }
}
