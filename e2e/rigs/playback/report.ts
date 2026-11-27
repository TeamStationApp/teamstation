import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { StepVerdict } from './verdict'

export interface RunReport {
  target: string
  content: string
  /** The command line that produced it, shown as `$ …` in the Markdown. */
  command: string
  startedAt: string
  finishedAt: string
  steps: Array<StepVerdict & { evidence?: unknown }>
}

/** `report-<target>-<content>.json` and `.md` in `dir`; returns the Markdown path. */
export function writeReport(dir: string, report: RunReport): string {
  mkdirSync(dir, { recursive: true })
  const base = join(
    dir,
    `report-${report.target}-${report.content.replace('+', 'plus')}`
  )
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n')
  writeFileSync(`${base}.md`, markdownOf(report))
  return `${base}.md`
}

export function markdownOf(report: RunReport): string {
  const passed = report.steps.filter(step => step.pass).length
  const lines = [
    `# Playback reliability — ${report.target}, ${report.content}`,
    '',
    `$ ${report.command}`,
    '',
    `${report.startedAt} → ${report.finishedAt}: ${passed} of ${report.steps.length} steps passed.`,
    '',
    '| Step | Result | Start | Why |',
    '| --- | --- | --- | --- |'
  ]
  for (const step of report.steps) {
    const why = [...step.reasons, ...step.notes.map(note => `note: ${note}`)]
      .join('; ')
      .replace(/\|/g, '\\|')
    lines.push(
      `| ${step.step} | ${step.pass ? 'pass' : '**FAIL**'} | ${step.startMs == null ? '—' : `${step.startMs} ms`} | ${why} |`
    )
  }
  return lines.join('\n') + '\n'
}
