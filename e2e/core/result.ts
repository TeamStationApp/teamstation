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
  /** What the run ran against: only fixture data can make a golden. */
  target?: { kind: string; seat?: string }
  /** Set on a fault run, whose captures can never become goldens. */
  fault?: string
  checkpoints: unknown[]
  /** What ended the scenario: a check that failed, or the test itself breaking. */
  failureKind?: 'assertion' | 'crash'
  /** The API's 5xx during a scenario that failed, whatever stopped it. */
  serverErrors?: unknown[]
  /** A seat's server errors no running scenario can claim, for the night's report. */
  unattributedServerErrors?: unknown[]
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
