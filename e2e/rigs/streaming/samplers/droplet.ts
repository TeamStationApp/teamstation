import { type Exec, type MemorySample, parsePsRss } from './sample'

/**
 * The stack's API and ingest RSS, informational only. `exec` runs a command on the
 * stack's machine (the remote runner the stack tooling provides); how to find each
 * process's pid is a command from the local settings, so nothing here says how the
 * stack runs its processes.
 */

export interface DropletProcess {
  /** What the report calls it: `api`, `ingest`. */
  process: string
  /** A command that prints the process's pid. */
  pidCommand: string[]
}

export async function sampleDroplet(options: {
  exec: Exec
  processes: DropletProcess[]
  now: () => number
}): Promise<MemorySample[]> {
  const atMs = options.now()
  const pids = new Map<number, string>()
  for (const { process, pidCommand } of options.processes) {
    const [command, ...args] = pidCommand
    const pid = Number((await options.exec(command, args)).trim())
    if (Number.isInteger(pid) && pid > 0) pids.set(pid, process)
  }
  if (pids.size === 0) return []
  const rss = parsePsRss(
    await options.exec('ps', [
      '-o',
      'pid=,rss=',
      '-p',
      [...pids.keys()].join(',')
    ])
  )
  return [...rss.entries()]
    .filter(([pid]) => pids.has(pid))
    .map(([pid, bytes]) => ({
      device: 'stack',
      process: pids.get(pid)!,
      atMs,
      bytes,
      pid
    }))
}
