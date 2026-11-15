import type { MemorySample } from '../soakRecords'

export type { MemorySample }

/** Runs a command and gives its standard output: locally, or on the droplet over SSH. */
export type Exec = (command: string, args: string[]) => Promise<string>

/** Reads `ps -o pid=,rss=` lines: pid → bytes (ps reports kilobytes). */
export function parsePsRss(output: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match != null) out.set(Number(match[1]), Number(match[2]) * 1024)
  }
  return out
}
