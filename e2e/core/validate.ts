import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { globToRegExp } from './glob'
import { type LegacyReport, legacyReport, readLegacy } from './legacy'
import { lintFile } from './lint'
import {
  buildManifest,
  loadSpec,
  renderManifest,
  ROOT,
  testFiles
} from './manifest'
import { specProblems } from './spec'

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

export function validate(
  root = ROOT,
  options: { strict?: boolean } = {}
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
    for (const problem of specProblems(spec)) {
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
  const report = legacyReport(readLegacy(root), tracked)
  if (strict) {
    for (const file of [...report.legacy, ...report.additions]) {
      problems.push(`${file}: tests belong under e2e/`)
    }
  }
  return { problems, ...report }
}
