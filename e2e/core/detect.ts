import { detectRow } from './detectRow'
import { appendLedger, type DetectRow } from './ledger'
import { type RunOptions, runScenario } from './run'

export { caughtByLayer } from './detectRow'

export interface DetectOutcome {
  row: DetectRow
  exitCode: number
  runDir: string
}

/**
 * Passes only when the scenario goes red under the fault. A run that could not start,
 * a known failure, or a test that only crashed proves nothing, so none counts as
 * caught.
 */
export async function detectFault(
  options: RunOptions & { fault: string },
  ledger: string
): Promise<DetectOutcome> {
  const { result, runDir, exitCode } = await runScenario({
    ...options,
    seat: undefined
  })
  const row = detectRow(result, {
    scenario: options.id,
    surface: options.surface,
    fault: options.fault
  })
  if (result.status === 'blocked' || result.status === 'harness-error') {
    return { row, exitCode, runDir }
  }
  appendLedger(ledger, row)
  return { row, exitCode: row.caught ? 0 : 1, runDir }
}
