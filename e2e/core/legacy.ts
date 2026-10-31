import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What has not moved into the suite yet. `tests` are unconverted tests, the only
 * list `legacy` counts; `helpers` are libraries and fixture files still to move;
 * `parked` are out of scope for now and stay where they are.
 */
export interface LegacyList {
  tests: string[]
  helpers: string[]
  parked: string[]
}

export function readLegacy(root: string): LegacyList {
  const path = join(root, 'e2e', 'legacy.json')
  if (!existsSync(path)) return { tests: [], helpers: [], parked: [] }
  return JSON.parse(readFileSync(path, 'utf8')) as LegacyList
}

export const SUITE_FILE = /\.(?:e2e|integration)\.[^/]+$/

export interface LegacyReport {
  legacy: string[]
  additions: string[]
  gone: string[]
}

/**
 * Sorts every suite-named file outside `e2e/`. One in no list is an addition, such
 * as a test from another branch; a listed one no longer on disk is reported too.
 */
export function legacyReport(
  list: LegacyList,
  tracked: string[]
): LegacyReport {
  const outside = tracked.filter(
    file => SUITE_FILE.test(file) && !file.startsWith('e2e/')
  )
  const known = new Set([...list.tests, ...list.helpers, ...list.parked])
  const present = new Set(tracked)
  return {
    legacy: list.tests,
    additions: outside.filter(file => !known.has(file)),
    gone: [...known].filter(file => !present.has(file))
  }
}
