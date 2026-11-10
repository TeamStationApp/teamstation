import { execFileSync } from 'node:child_process'

import type { ServerError } from './invariants'
import type { LocalSettings } from './settings'

/**
 * A seat's 5xx since a time, from `<seatCommand> logs --since <iso>`, which prints one
 * JSON object per request. Undefined when this machine has no seat command.
 */
export function seatServerErrors(
  settings: LocalSettings,
  since: number
): ServerError[] | undefined {
  if (settings.seatCommand == null) return undefined
  const output = execFileSync(
    settings.seatCommand,
    ['logs', '--since', new Date(since).toISOString()],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as ServerError)
    .filter(row => row.status >= 500)
}
