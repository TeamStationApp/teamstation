import { FAULTS } from '../faults/catalogue'
import type { CheckpointRecord } from './checkpoint'
import { failedInvariants } from './invariants'
import type { DetectRow } from './ledger'
import type { RunResult } from './result'

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

/**
 * The ledger row of a run under a fault. Only a red run is caught, and a
 * test that only crashed proves nothing, so it never counts as caught.
 */
export function detectRow(
  result: RunResult,
  run: { scenario: string; surface: string; fault: string },
  at: Date = new Date()
): DetectRow {
  const failed = result.status === 'failed'
  const caughtBy = failed ? caughtByLayer(result, run.fault) : 'none'
  return {
    kind: 'detect',
    at: at.toISOString(),
    scenario: run.scenario,
    surface: run.surface,
    fault: run.fault,
    ref: result.ref,
    caught: failed && caughtBy !== 'test-crash',
    caughtBy,
    expectedLayer:
      FAULTS[run.fault]?.caughtBy.includes(caughtBy as never) ?? false,
    status: result.status
  }
}
