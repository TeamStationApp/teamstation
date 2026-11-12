import type { Exec, MemorySample } from './sample'

/**
 * Memory on the Android phones: `dumpsys meminfo <package>`'s TOTAL PSS, in kilobytes,
 * and the pid it reports, so a relaunch shows as a new process.
 */

export function meminfoArgs(serial: string, pkg: string): string[] {
  return ['-s', serial, 'shell', 'dumpsys', 'meminfo', pkg]
}

export interface Meminfo {
  pid: number | null
  pssBytes: number
}

/** TOTAL PSS from the App Summary, or the TOTAL row's first figure on an older Android. */
export function parseMeminfo(output: string): Meminfo | null {
  if (/No process found/i.test(output)) return null
  const pid = /MEMINFO in pid (\d+)/.exec(output)
  const summary = /TOTAL PSS:\s+(\d+)/.exec(output)
  const row = /^\s*TOTAL\s+(\d+)/m.exec(output)
  const kb = summary?.[1] ?? row?.[1]
  if (kb == null) return null
  return {
    pid: pid == null ? null : Number(pid[1]),
    pssBytes: Number(kb) * 1024
  }
}

export async function sampleMeminfo(
  exec: Exec,
  options: {
    device: string
    serial: string
    package: string
    process?: string
    now: () => number
  }
): Promise<MemorySample[]> {
  const output = await exec('adb', meminfoArgs(options.serial, options.package))
  const read = parseMeminfo(output)
  if (read == null) return []
  return [
    {
      device: options.device,
      process: options.process ?? options.package,
      atMs: options.now(),
      bytes: read.pssBytes,
      ...(read.pid == null ? {} : { pid: read.pid })
    }
  ]
}
