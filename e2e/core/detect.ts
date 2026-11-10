import { FAULTS } from '../faults/catalogue'
import type { CheckpointRecord } from './checkpoint'
import { failedInvariants } from './invariants'
import { appendLedger, type DetectRow } from './ledger'
import type { RunResult } from './result'
import { type RunOptions, runScenario } from './run'

/**
 * Which layer turned the run red, read from what it recorded. A crash proves no layer
 * saw the fault, so it is named as what it is, and the catalogue never expects it.
 */
export function caughtByLayer(result: RunResult, fault?: string): string {
  for (const record of result.checkpoints as CheckpointRecord[]) {
    if (
      record.invariants != null &&
      failedInvariants(record.invariants).length > 0
    ) {
      return 'invariant'
    }
    if (record.expect === 'fail') return 'expect'
    if (record.readBack === 'fail') return 'read-back'
    if (record.visual?.verdict === 'fail') return 'golden'
    if (record.ask?.verdict === 'fail') return 'ai'
  }
  if (result.failureKind === 'crash') return 'test-crash'
  // A direct assertion stopped the scenario before a checkpoint saw the screen. The
  // proxy's record says when the server's failure is why, but only for a fault that
  // makes one: a server the scenario shuts down answers 502s of its own afterwards.
  const makesErrors =
    fault != null && FAULTS[fault]?.caughtBy.includes('invariant')
  if (makesErrors && (result.serverErrors ?? []).length > 0) {
    return 'invariant'
  }
  return 'expect'
}

export interface DetectOutcome {
  row: DetectRow
  exitCode: number
  runDir: string
}

/**
 * Passes only when the scenario goes red under the fault. A run that could not start,
 * or a known failure, proves nothing, so neither counts as caught.
 */
export async function detectFault(
  options: RunOptions & { fault: string },
  ledger: string
): Promise<DetectOutcome> {
  const { result, runDir, exitCode } = await runScenario({
    ...options,
    seat: undefined
  })
  const caught = result.status === 'failed'
  const caughtBy = caught ? caughtByLayer(result, options.fault) : 'none'
  const row: DetectRow = {
    kind: 'detect',
    at: new Date().toISOString(),
    scenario: options.id,
    surface: options.surface,
    fault: options.fault,
    ref: result.ref,
    caught,
    caughtBy,
    expectedLayer:
      FAULTS[options.fault]?.caughtBy.includes(caughtBy as never) ?? false,
    status: result.status
  }
  if (result.status === 'blocked' || result.status === 'harness-error') {
    return { row, exitCode, runDir }
  }
  appendLedger(ledger, row)
  return { row, exitCode: caught ? 0 : 1, runDir }
}
