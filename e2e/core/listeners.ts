import { spawnSync } from 'node:child_process'

/** A TCP socket a process listens on. */
export interface Listener {
  pid: number
  command: string
  address: string
}

/** Reads `lsof -F pcn` output into its listeners. */
export function parseLsof(output: string): Listener[] {
  const out: Listener[] = []
  let pid = 0
  let command = ''
  for (const line of output.split('\n')) {
    const value = line.slice(1)
    if (line.startsWith('p')) pid = Number(value)
    else if (line.startsWith('c')) command = value
    else if (line.startsWith('n')) out.push({ pid, command, address: value })
  }
  return out
}

/**
 * Listeners the shared-Mac rule allows a run's own processes: a browser's
 * debugging port, which the OS assigns, on loopback. maestro-d's daemon
 * socket and device links belong to the daemon, which is not this run's child.
 */
export function disallowed(listeners: Listener[]): Listener[] {
  return listeners.filter(
    listener =>
      !(
        /chrom/i.test(listener.command) &&
        /^(127\.0\.0\.1|\[::1\]):\d+$/.test(listener.address)
      )
  )
}

/** Every descendant of `root`, `root` included. */
export function processTree(
  root: number,
  children: (pid: number) => number[]
): number[] {
  const seen = [root]
  // The iterator reads the length each step, so it walks the children it adds.
  for (const pid of seen) {
    for (const child of children(pid)) {
      if (!seen.includes(child)) seen.push(child)
    }
  }
  return seen
}

function childrenOf(pid: number): number[] {
  const found = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  return found.stdout.split('\n').filter(Boolean).map(Number)
}

/** What this process and its children listen on over TCP that the rule does not allow. */
export function auditListeners(root: number = process.pid): Listener[] {
  const pids = processTree(root, childrenOf)
  // /usr/sbin is often off an agent's PATH. lsof exits 1 when nothing listens.
  const listed = spawnSync(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fpcn'],
    { encoding: 'utf8' }
  )
  if (listed.error != null) {
    throw new Error(
      `the listener audit could not run lsof: ${listed.error.message}`
    )
  }
  return disallowed(parseLsof(listed.stdout))
}

export function describeListeners(listeners: Listener[]): string {
  return listeners
    .map(listener => `${listener.command}[${listener.pid}] ${listener.address}`)
    .join(', ')
}
