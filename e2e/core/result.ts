import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A scenario's outcome. Inconclusive is never read as a pass. */
export type Status =
  | 'passed'
  | 'passed-degraded'
  | 'failed'
  | 'quarantined'
  | 'blocked'
  | 'harness-error'
  | 'needs-review'
  | 'unbaselined'

const EXIT_CODES: Record<Status, number> = {
  passed: 0,
  'passed-degraded': 0,
  failed: 1,
  quarantined: 1,
  blocked: 2,
  'harness-error': 3,
  'needs-review': 4,
  unbaselined: 4
}

export function exitCodeFor(status: Status): number {
  return EXIT_CODES[status]
}

export interface RunResult {
  scenario: string
  surface: string
  ref: string
  deviceClass: string
  status: Status
  reason?: string
  durationMs: number
  costUsd: number
  degradations: string[]
  checkpoints: unknown[]
}

export function writeResult(runDir: string, result: RunResult): string {
  mkdirSync(runDir, { recursive: true })
  const path = join(runDir, 'result.json')
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n')
  return path
}

/** Thrown for a need the run cannot meet: exit 2, never a failure of the app. */
export class BlockedError extends Error {}

/** Thrown when the harness itself breaks: exit 3, never a failure of the app. */
export class HarnessError extends Error {}
