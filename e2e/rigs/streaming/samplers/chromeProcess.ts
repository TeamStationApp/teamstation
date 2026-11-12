import { type Exec, type MemorySample, parsePsRss } from './sample'

/**
 * Memory in Chrome: the tab's renderer RSS, its pid from CDP `SystemInfo.getProcessInfo`
 * (the largest renderer, as the soak's window has one tab), and the page's
 * `JSHeapUsedSize` from `Performance.getMetrics`.
 */

export type CdpSend = (
  method: string,
  params?: Record<string, unknown>
) => Promise<unknown>

export interface ProcessInfo {
  type: string
  id: number
}

export function rendererPids(info: unknown): number[] {
  const list = (info as { processInfo?: ProcessInfo[] }).processInfo ?? []
  return list
    .filter(process => process.type === 'renderer')
    .map(process => process.id)
}

export function jsHeapUsed(metrics: unknown): number | null {
  const list =
    (metrics as { metrics?: Array<{ name: string; value: number }> }).metrics ??
    []
  return list.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null
}

export async function sampleChrome(options: {
  browser: CdpSend
  page: CdpSend
  exec: Exec
  now: () => number
  device?: string
}): Promise<MemorySample[]> {
  const device = options.device ?? 'chrome'
  const atMs = options.now()
  const out: MemorySample[] = []
  const pids = rendererPids(await options.browser('SystemInfo.getProcessInfo'))
  if (pids.length > 0) {
    const rss = parsePsRss(
      await options.exec('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')])
    )
    const largest = [...rss.entries()].sort((a, b) => b[1] - a[1])[0]
    if (largest != null)
      out.push({
        device,
        process: 'renderer',
        atMs,
        bytes: largest[1],
        pid: largest[0]
      })
  }
  await options.page('Performance.enable')
  const heap = jsHeapUsed(await options.page('Performance.getMetrics'))
  if (heap != null) out.push({ device, process: 'jsHeap', atMs, bytes: heap })
  return out
}
