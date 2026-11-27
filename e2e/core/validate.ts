import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { migrations } from '../../src/migrate/migrations'
import { faultProblems } from '../faults/catalogue'
import { capabilityProblems, gpuProblems } from './capabilities'
import { dumpProblems, type PgTool } from './dumps'
import { globToRegExp } from './glob'
import { readGoldenSuite } from './goldens'
import { type LegacyReport, legacyReport, readLegacy } from './legacy'
import { lintFile, noInfraProblems } from './lint'
import {
  buildManifest,
  loadSpec,
  renderManifest,
  ROOT,
  testFiles
} from './manifest'
import {
  computeFreeze,
  freezeProblems,
  isUnitTest,
  legacyOnlyRigs,
  moduleOf,
  moduleProblems,
  readFreeze
} from './modules'
import { type E2eSpec, OLD_SERVICES, SERVICES, specProblems } from './spec'

export interface ValidationReport extends LegacyReport {
  problems: string[]
  /** Under `--strict`: how many rigs only unconverted legacy modules reach, which the lint waits on. */
  lintSkipped?: number
}

/** The source files the `no-infra` rule reads: every test and rig, in any language a helper could be written in. */
const NO_INFRA_FILE = /^e2e\/(?:tests|rigs)\/.*\.(?:tsx?|[cm]?js|swift)$/

/**
 * A spec outside the streaming freeze in the old vocabulary: `hardware`, a
 * `seat` stack, an old service name, or a role that does not say whether a
 * simulator may stand in.
 */
export function oldVocabularyProblems(
  spec: Pick<E2eSpec, 'stack' | 'services' | 'surfaces'>
): string[] {
  const problems: string[] = []
  if (spec.stack === 'seat') {
    problems.push("stack 'seat' is gone: use 'isolated' with a world")
  }
  for (const service of spec.services) {
    if ((OLD_SERVICES as readonly string[]).includes(service)) {
      problems.push(`service "${service}" is an old name`)
    }
  }
  for (const [surface, needs] of Object.entries(spec.surfaces)) {
    for (const need of needs?.devices ?? []) {
      if ('hardware' in need) {
        problems.push(
          `${surface}: role "${need.role}" says hardware: say simulator`
        )
      }
      if (need.simulator == null) {
        problems.push(
          `${surface}: role "${need.role}" must say simulator: 'allowed' or 'never'`
        )
      }
    }
  }
  return problems
}

/**
 * `no-infra` and `no-ask` over every test and rig source file, less the
 * streaming freeze, the rigs waiting on their legacy category, and mocha
 * unit tests, which run on no runner.
 */
export function infraProblems(
  root: string,
  tracked: string[],
  frozen: ReadonlySet<string>,
  waiting: ReadonlySet<string>
): string[] {
  const problems: string[] = []
  for (const file of tracked) {
    if (!NO_INFRA_FILE.test(file) || isUnitTest(file)) continue
    if (frozen.has(file) || waiting.has(file)) continue
    const text = readFileSync(join(root, file), 'utf8')
    for (const problem of noInfraProblems(file, text)) {
      problems.push(`${problem.file}: ${problem.rule}: ${problem.detail}`)
    }
    for (const problem of askProblems(text)) {
      problems.push(`${file}: no-ask: ${problem}`)
    }
  }
  return problems
}

/** A checkpoint asking the frozen judge: `compare: 'ai'` with a `prompt` asks the waterfall. */
export function askProblems(text: string): string[] {
  const problems: string[] = []
  for (const match of text.matchAll(/(?:^|[\s{,])ask\s*:/gm)) {
    const line = text.slice(0, match.index).split('\n').length
    problems.push(`line ${line}: ask is the frozen judge: use compare: 'ai'`)
  }
  return problems
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
  const legacyList = readLegacy(root)
  const frozen = new Set(
    strict
      ? (readFreeze(root) ?? computeFreeze(tracked, legacyList, root)).files
      : []
  )
  const waiting = strict
    ? legacyOnlyRigs(tracked, legacyList, root)
    : new Set<string>()
  for (const file of testFiles(root)) {
    const spec = loadSpec(file, root)
    const outside = strict && !frozen.has(file)
    for (const problem of [
      ...specProblems(spec),
      ...needProblems(spec),
      ...(outside ? [...oldVocabularyProblems(spec), ...gpuProblems(spec)] : [])
    ]) {
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
    // A rig only unconverted legacy modules reach is linted once its category converts.
    if (waiting.has(file)) continue
    const text = readFileSync(join(root, file), 'utf8')
    for (const problem of lintFile(file, text)) {
      problems.push(`${problem.file}: ${problem.rule}: ${problem.detail}`)
    }
  }
  if (strict) {
    problems.push(...infraProblems(root, tracked, frozen, waiting))
    problems.push(...freezeProblems(tracked, legacyList, root))
  }
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
  return {
    problems,
    ...report,
    ...(strict ? { lintSkipped: waiting.size } : {})
  }
}
