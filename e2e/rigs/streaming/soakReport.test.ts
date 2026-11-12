import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { MemorySample, RecordedEvent, RecordedProbe } from './soakRecords'
import { iphoneForeground, main, reduceRun, reduceRunDir } from './soakReport'
import { soakSchedule } from './soakSchedule'

const T0 = 9_000_000
const MIN = 60_000

function run(): {
  events: RecordedEvent[]
  probes: RecordedProbe[]
  memory: MemorySample[]
} {
  const events: RecordedEvent[] = [
    {
      atMs: T0,
      target: 'run',
      action: 'runStart',
      args: {
        provenance: {
          build: 'develop@0000000',
          stack: 'streamtest-000000000000'
        }
      }
    },
    { atMs: T0, target: 'publisherA', action: 'startPublisher' },
    { atMs: T0, target: 'publisherB', action: 'startPublisher' },
    { atMs: T0, target: 'publisherC', action: 'startPublisher' },
    { atMs: T0 + 1000, doneMs: T0 + 2000, target: 'android', action: 'join' },
    {
      atMs: T0 + 30 * MIN,
      doneMs: T0 + 30 * MIN,
      target: 'android',
      action: 'skip'
    },
    {
      atMs: T0 + 40 * MIN,
      doneMs: T0 + 40 * MIN,
      target: 'android',
      action: 'relaunch'
    },
    {
      atMs: T0 + 20 * MIN,
      target: 'iphone',
      action: 'switchSurface',
      args: { to: 'safari' }
    }
  ]
  const probes: RecordedProbe[] = [
    {
      atMs: T0 + 30 * MIN + 2000,
      surface: 'android',
      tiles: [
        { angle: 'Phone A', advancing: false, notice: null },
        { angle: 'Phone B', advancing: true, notice: null },
        { angle: 'Synthetic', advancing: true, notice: null }
      ],
      bar: 0.4,
      foreground: true,
      screenshots: ['shots/android-1.png']
    },
    {
      atMs: T0 + 50 * MIN,
      surface: 'android',
      tiles: null,
      bar: null,
      foreground: null,
      reason: 'no hierarchy'
    }
  ]
  const memory: MemorySample[] = []
  for (let minute = 0; minute <= 120; minute++) {
    memory.push({
      device: 'android',
      process: 'TeamStation',
      atMs: T0 + minute * MIN,
      bytes: 300e6
    })
    memory.push({
      device: 'iphone',
      process: 'com.apple.WebKit.WebContent',
      atMs: T0 + minute * MIN,
      bytes: 200e6
    })
  }
  return { events, probes, memory }
}

describe('the soak report', function () {
  it('reduces a run to verdicts, counts, failures and provenance', function () {
    const report = reduceRun({
      ...run(),
      result: { ref: 'develop', target: { kind: 'stack' } }
    })
    expect(report.verdict).equals('failed')
    expect(report.exitCode).equals(1)
    expect(report.markdown).contains('Verdict: **failed**')
    expect(report.markdown).contains('- build: "develop@0000000"')
    expect(report.markdown).contains('- ref: "develop"')
    expect(report.markdown).contains('| android | skip | 0 / 1 | 1 | 0 |')
    expect(report.markdown).match(
      /\*\*seekRecovery\*\* on android \(skip\) at 30:00/
    )
    expect(report.markdown).contains(
      '[shots/android-1.png](shots/android-1.png)'
    )
    expect(report.markdown).contains('no hierarchy')
    expect(report.markdown).contains(
      '| android | TeamStation | passed | 300.0 | 300.0 | 0.0 % | 0.0 | 2 |'
    )
    expect(report.csv.split('\n')[0]).equals('device,process,minute,bytes,pid')
  })

  it('judges the iPhone Safari process only while Safari was in front', function () {
    const report = reduceRun(run())
    const safari = report.memory.find(row => row.device === 'iphone')!
    expect(safari.lifetimes[0].startMs).equals(T0 + 20 * MIN)
    expect(
      iphoneForeground(
        [
          {
            atMs: 5,
            target: 'iphone',
            action: 'switchSurface',
            args: { to: 'safari' }
          },
          {
            atMs: 7,
            target: 'iphone',
            action: 'switchSurface',
            args: { to: 'safari' }
          },
          {
            atMs: 9,
            target: 'iphone',
            action: 'switchSurface',
            args: { to: 'app' }
          }
        ],
        0,
        20
      )
    ).deep.equals({
      app: [
        [0, 5],
        [9, 20]
      ],
      safari: [[5, 9]]
    })
  })

  it('passes a clean run, and takes its windows from the recorded phases', function () {
    const phases = soakSchedule({ minutes: 15 }).phases
    const report = reduceRun({
      events: [
        { atMs: T0, target: 'run', action: 'runStart', args: { phases } }
      ],
      probes: [],
      memory: []
    })
    expect(report.verdict).equals('blocked')
    expect(report.exitCode).equals(2)
    expect(report.markdown).contains('Not recorded.')
    expect(report.markdown).contains('## Failures\n\nNone.')
  })

  it('reads and writes a run directory, and runs as a command', function () {
    const dir = mkdtempSync(join(tmpdir(), 'soak-report-'))
    try {
      const { events, probes, memory } = run()
      const lines = (rows: unknown[]): string =>
        rows.map(row => JSON.stringify(row)).join('\n') + '\n'
      writeFileSync(join(dir, 'events.jsonl'), lines(events))
      writeFileSync(join(dir, 'probes.jsonl'), lines(probes))
      writeFileSync(join(dir, 'memory.jsonl'), lines(memory))
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ ref: 'abc' }))
      const report = reduceRunDir(dir)
      expect(readFileSync(join(dir, 'report.md'), 'utf8')).equals(
        report.markdown
      )
      expect(readFileSync(join(dir, 'memory.csv'), 'utf8')).equals(report.csv)
      const said: string[] = []
      const out = {
        log: (line: string) => said.push(line),
        error: (line: string) => said.push(line)
      }
      expect(main([dir], out)).equals(1)
      expect(said[0]).match(/^failed: .*report\.md$/)
      expect(main([], out)).equals(3)
      const empty = mkdtempSync(join(tmpdir(), 'soak-report-empty-'))
      try {
        expect(reduceRunDir(empty).verdict).equals('blocked')
      } finally {
        rmSync(empty, { recursive: true })
      }
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
