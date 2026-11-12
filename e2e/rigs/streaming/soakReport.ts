import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  evaluateGates,
  type GateInstance,
  type GateReport,
  overallVerdict,
  type Verdict
} from './soakGates'
import {
  FULL_WINDOWS,
  judgeMemory,
  memoryCsv,
  type MemoryWindows,
  type ProcessVerdict,
  windowsFromPhases
} from './soakMemory'
import {
  type MemorySample,
  readJsonl,
  type RecordedEvent,
  type RecordedProbe
} from './soakRecords'
import type { SoakPhases } from './soakSchedule'

/**
 * Reduces a soak's run directory to `report.md` and `memory.csv`: per-gate and
 * per-surface counts, the memory verdicts and curves, every failure with its timestamps
 * and screenshots, and the build and stack the run used.
 *
 *   node -r sucrase/register e2e/rigs/streaming/soakReport.ts <run-dir>
 */

export interface SoakReport {
  verdict: Verdict
  exitCode: number
  gates: GateReport
  memory: ProcessVerdict[]
  markdown: string
  csv: string
}

function readIf<T>(path: string): T[] {
  return existsSync(path) ? readJsonl<T>(path) : []
}

function deviceOf(target: string): string {
  return target.startsWith('iphone') ? 'iphone' : target
}

/** When the iPhone's app and Safari were each in front, from the switches. */
export function iphoneForeground(
  events: RecordedEvent[],
  runStartMs: number,
  endMs: number
): { app: Array<[number, number]>; safari: Array<[number, number]> } {
  const out = {
    app: [] as Array<[number, number]>,
    safari: [] as Array<[number, number]>
  }
  let front: 'app' | 'safari' = 'app'
  let since = runStartMs
  const switches = events
    .filter(event => event.action === 'switchSurface')
    .sort((a, b) => a.atMs - b.atMs)
  for (const change of switches) {
    const to = change.args?.to === 'safari' ? 'safari' : 'app'
    if (to === front) continue
    out[front].push([since, change.atMs])
    front = to
    since = change.atMs
  }
  out[front].push([since, endMs])
  return out
}

function clock(atMs: number, runStartMs: number): string {
  const total = Math.max(0, Math.round((atMs - runStartMs) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function mb(bytes: number | undefined): string {
  return bytes == null ? '–' : (bytes / 1e6).toFixed(1)
}

function failureLine(instance: GateInstance, runStartMs: number): string {
  const shots = (instance.screenshots ?? []).map(path => `[${path}](${path})`)
  return [
    `- **${instance.gate}** on ${instance.surface} (${instance.kind}) at ${clock(instance.atMs, runStartMs)}`,
    `(${new Date(instance.atMs).toISOString()})`,
    instance.recurrence == null ? '' : `, ${instance.recurrence}`,
    instance.reason == null ? '' : `: ${instance.reason}`,
    shots.length > 0 ? ` — ${shots.join(', ')}` : ''
  ]
    .join(' ')
    .replace(/ +,/g, ',')
}

export function renderMarkdown(input: {
  verdict: Verdict
  gates: GateReport
  memory: ProcessVerdict[]
  runStartMs: number
  provenance: Record<string, unknown>
}): string {
  const { verdict, gates, memory, runStartMs, provenance } = input
  const lines: string[] = [
    '# Streaming soak report',
    '',
    `Verdict: **${verdict}**`,
    ''
  ]
  lines.push('## Provenance', '')
  const keys = Object.keys(provenance)
  if (keys.length === 0) lines.push('Not recorded.')
  for (const key of keys) {
    lines.push(`- ${key}: ${JSON.stringify(provenance[key])}`)
  }
  lines.push(
    '',
    '## Gates',
    '',
    '| Gate | Passed | Run | Failed | Blocked |',
    '| --- | --- | --- | --- | --- |'
  )
  const byGate = new Map<
    string,
    { passed: number; run: number; failed: number; blocked: number }
  >()
  for (const instance of gates.instances) {
    const row = byGate.get(instance.gate) ?? {
      passed: 0,
      run: 0,
      failed: 0,
      blocked: 0
    }
    row.run++
    row[instance.verdict]++
    byGate.set(instance.gate, row)
  }
  for (const [gate, row] of byGate) {
    lines.push(
      `| ${gate} | ${row.passed} | ${row.run} | ${row.failed} | ${row.blocked} |`
    )
  }
  lines.push(
    '',
    '## Per surface and kind',
    '',
    '| Surface | Kind | Passed / run | Failed | Blocked |',
    '| --- | --- | --- | --- | --- |'
  )
  const counts = [...gates.counts].sort((a, b) => {
    const surface = a.surface.localeCompare(b.surface)
    return surface !== 0 ? surface : a.kind.localeCompare(b.kind)
  })
  for (const row of counts) {
    lines.push(
      `| ${row.surface} | ${row.kind} | ${row.passed} / ${row.run} | ${row.failed} | ${row.blocked} |`
    )
  }
  lines.push(
    '',
    '## Memory',
    '',
    '| Device | Process | Verdict | First MB | Last MB | Growth | Slope MB/h | Lifetimes | Note |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const row of memory) {
    lines.push(
      `| ${row.device} | ${row.process} | ${row.verdict} | ${mb(row.baselineMedian)} | ${mb(row.finalMedian)} | ${
        row.growth == null ? '–' : `${(row.growth * 100).toFixed(1)} %`
      } | ${row.slopeMBh == null ? '–' : row.slopeMBh.toFixed(1)} | ${row.lifetimes.length} | ${row.reason ?? ''} |`
    )
  }
  lines.push(
    '',
    'The curves are in [memory.csv](memory.csv).',
    '',
    '## Failures',
    ''
  )
  const failures = gates.instances.filter(
    instance => instance.verdict === 'failed'
  )
  if (failures.length === 0) lines.push('None.')
  for (const failure of failures) lines.push(failureLine(failure, runStartMs))
  const blocked = gates.instances.filter(
    instance => instance.verdict === 'blocked'
  )
  lines.push('', '## Blocked', '')
  if (blocked.length === 0) lines.push('None.')
  for (const instance of blocked) lines.push(failureLine(instance, runStartMs))
  return lines.join('\n') + '\n'
}

const EXIT: Record<Verdict, number> = { passed: 0, failed: 1, blocked: 2 }

export function reduceRun(input: {
  events: RecordedEvent[]
  probes: RecordedProbe[]
  memory: MemorySample[]
  result?: Record<string, unknown>
  windows?: MemoryWindows
}): SoakReport {
  const { events, probes, memory } = input
  const start = events.find(event => event.action === 'runStart')
  const runStartMs =
    start?.atMs ?? Math.min(...events.map(event => event.atMs), Date.now())
  const phases = start?.args?.phases as SoakPhases | undefined
  const windows =
    input.windows ?? (phases == null ? FULL_WINDOWS : windowsFromPhases(phases))
  const endMs = Math.max(
    runStartMs,
    ...events.map(event => event.doneMs ?? event.atMs),
    ...memory.map(sample => sample.atMs + 1)
  )
  const relaunches: Record<string, number[]> = {}
  for (const event of events) {
    if (event.action !== 'relaunch') continue
    const device = deviceOf(event.target)
    relaunches[device] = [...(relaunches[device] ?? []), event.atMs]
  }
  const front = iphoneForeground(events, runStartMs, endMs)
  const foreground: Record<string, Array<[number, number]>> = {}
  for (const sample of memory) {
    if (sample.device !== 'iphone') continue
    foreground[`iphone/${sample.process}`] = /webcontent|safari/i.test(
      sample.process
    )
      ? front.safari
      : front.app
  }
  const gates = evaluateGates(events, probes)
  const verdicts = judgeMemory(memory, {
    runStartMs,
    windows,
    relaunches,
    foreground
  })
  const memoryVerdicts = verdicts
    .map(row => row.verdict)
    .filter((verdict): verdict is Verdict => verdict !== 'informational')
  const verdict = overallVerdict([gates.verdict, ...memoryVerdicts])
  const provenance: Record<string, unknown> = {
    ...((start?.args?.provenance as Record<string, unknown> | undefined) ?? {})
  }
  for (const key of ['ref', 'target', 'scenario']) {
    if (input.result?.[key] != null) provenance[key] = input.result[key]
  }
  return {
    verdict,
    exitCode: EXIT[verdict],
    gates,
    memory: verdicts,
    markdown: renderMarkdown({
      verdict,
      gates,
      memory: verdicts,
      runStartMs,
      provenance
    }),
    csv: memoryCsv(memory, runStartMs)
  }
}

/** Reads a run directory, writes `report.md` and `memory.csv` beside it. */
export function reduceRunDir(dir: string, windows?: MemoryWindows): SoakReport {
  const resultPath = join(dir, 'result.json')
  const report = reduceRun({
    events: readIf<RecordedEvent>(join(dir, 'events.jsonl')),
    probes: readIf<RecordedProbe>(join(dir, 'probes.jsonl')),
    memory: readIf<MemorySample>(join(dir, 'memory.jsonl')),
    result: existsSync(resultPath)
      ? (JSON.parse(readFileSync(resultPath, 'utf8')) as Record<
          string,
          unknown
        >)
      : undefined,
    windows
  })
  writeFileSync(join(dir, 'report.md'), report.markdown)
  writeFileSync(join(dir, 'memory.csv'), report.csv)
  return report
}

export function main(
  argv: string[],
  out: Pick<Console, 'log' | 'error'> = console
): number {
  const dir = argv[0]
  if (dir == null) {
    out.error('Usage: soakReport.ts <run-dir>')
    return 3
  }
  const report = reduceRunDir(dir)
  out.log(`${report.verdict}: ${join(dir, 'report.md')}`)
  return report.exitCode
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))
