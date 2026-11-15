import { execFileSync } from 'node:child_process'

import type { ServerError } from './invariants'
import { BlockedError, HarnessError } from './result'
import type { LocalSettings } from './settings'

/**
 * Runs the local seat command and gives its output. A command this machine
 * lacks blocks the run; one that fails is the harness's error, never the app's.
 */
export function runSeatCommand(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stderr?: string }
    if (failed.code === 'ENOENT') {
      throw new BlockedError(`the seat command is not at ${command}`)
    }
    const stderr = (failed.stderr ?? '').trim()
    const detail = stderr === '' ? failed.message : stderr
    throw new HarnessError(`seat command ${args[0]} failed: ${detail}`)
  }
}

/** Each line of a seat command's output, read as JSON. */
export function seatJsonLines<T>(output: string, what: string): T[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as T
      } catch {
        throw new HarnessError(
          `${what} printed a line that is not JSON: ${line}`
        )
      }
    })
}

/**
 * A seat's 5xx since a time, from `<seatCommand> logs --since <iso>`, which prints one
 * JSON object per request. Undefined when this machine has no seat command.
 */
export function seatServerErrors(
  settings: LocalSettings,
  since: number
): ServerError[] | undefined {
  if (settings.seatCommand == null) return undefined
  const output = runSeatCommand(settings.seatCommand, [
    'logs',
    '--since',
    new Date(since).toISOString()
  ])
  return seatJsonLines<ServerError>(output, 'seat logs').filter(
    row => row.status >= 500
  )
}
