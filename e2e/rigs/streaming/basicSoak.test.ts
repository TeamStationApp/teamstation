import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  BASIC_ANGLES,
  basicReport,
  basicScrub,
  basicWindows,
  machineLine,
  planActions,
  playState,
  watchersFromEnv
} from './basicSoak'
import { FRAME_DRAIN_SCRIPT } from './chromeFrames'
import type { MemorySample } from './soakRecords'
import type { SoakSampler } from './soakRun'
import type { StreamingWorld } from './streamingSession'
import {
  type Look,
  type LookTile,
  type PublisherLike,
  Recorder,
  type TargetedDriver,
  type TargetedSession,
  verdicts,
  type Watcher
} from './targeted'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 14, 20, 0, 0)

function driver(
  name: string,
  calls: string[],
  scrubFails = false
): TargetedDriver {
  let failed = false
  return {
    name,
    join: async () => {},
    cut: async () => {},
    scrub: async fraction => {
      if (scrubFails && !failed) {
        failed = true
        throw new Error('no bar on screen')
      }
      calls.push(`${name} scrub ${fraction.toFixed(2)}`)
    },
    rapidScrub: async fractions => {
      calls.push(`${name} rapid ${fractions.length}`)
    },
    skip: async () => {},
    slowMotion: async () => {},
    jumpToPresent: async () => {
      calls.push(`${name} jump`)
    },
    exitAndReenter: async () => {},
    relaunch: async () => {},
    probe: async () => ({ tiles: [], bar: null, foreground: true })
  }
}

function fakeSession(): {
  session: TargetedSession
  steps: Recorder['steps']
  calls: string[]
  written: Map<string, string>
  clock: { t: number }
  /** How often the frame logger was put into the page. */
  installs: () => number
} {
  const clock = { t: T0 }
  const now = (): number => clock.t
  const calls: string[] = []
  const written = new Map<string, string>()
  const record = new Recorder(
    join(mkdtempSync(join(tmpdir(), 'basic-soak-')), 'targeted.jsonl'),
    name => name,
    now
  )
  let drained = 0
  let installs = 0
  let lastDrain = T0
  const chrome: Watcher = {
    role: 'chrome',
    surface: driver('chrome', calls),
    evaluate: async script => {
      if (script !== FRAME_DRAIN_SCRIPT) {
        installs++
        return 'installed'
      }
      // Each drain hands over every frame since the last, SynthA's picture freezing after the third.
      drained++
      const rows: unknown[] = []
      const from = lastDrain
      lastDrain = now()
      for (let i = 0; from + i * 33 < now(); i++) {
        const at = from + i * 33
        for (const angle of BASIC_ANGLES) {
          const frozen = angle === 'SynthA' && drained > 3
          rows.push([angle, i, 0, at, frozen ? 1000 : at % 86_400_000])
        }
      }
      return JSON.stringify(rows)
    }
  }
  const watchers: Watcher[] = [
    { role: 'iphone', surface: driver('iphone', calls, true) },
    { role: 'android', surface: driver('android', calls) },
    chrome,
    { role: 'tv', surface: driver('tv', calls) },
    { role: 'safari', surface: driver('safari', calls) }
  ]
  const look = async (watcher: Watcher): Promise<Look> => {
    // The Android angles never move; the others play, 200 ms apart.
    // The TV shows its tiles, but without its picture whether they move is unknown.
    const still = watcher.role === 'android'
    return {
      atMs: now(),
      tiles: BASIC_ANGLES.map((angle, i) => ({
        angle,
        advancing: watcher.role === 'tv' ? null : !still,
        notice: still
          ? 'Waiting for this camera to catch up to the game…'
          : null,
        wallMs: now() - 3000 + i * 200
      }))
    }
  }
  let sampled = 0
  const sampler: SoakSampler = {
    name: 'fake',
    start: async () => {},
    sample: async at => {
      sampled++
      return [
        {
          device: 'android',
          process: 'app.teamstation.develop',
          atMs: at,
          bytes: 500e6 + sampled * 20e6,
          pid: 1
        }
      ] as MemorySample[]
    },
    stop: async () => []
  }
  const session: TargetedSession = {
    world: { world: { gameId: 'g', streams: [] } } as unknown as StreamingWorld,
    watchers,
    publishers: new Map<string, PublisherLike>(),
    owner: { endCamera: async () => {} },
    record,
    takeStartMs: T0,
    clockBase: () => undefined,
    streamId: label => label,
    look,
    seekTo: async () => null,
    sleep: async ms => {
      clock.t += ms
    },
    now,
    shapedIps: {},
    memory: [sampler],
    writeArtifact: (name, text) => {
      written.set(name, text)
    }
  }
  return {
    session,
    steps: record.steps,
    calls,
    written,
    clock,
    installs: () => installs
  }
}

describe('the basic streaming soak', function () {
  it('staggers each watcher’s scrubs and cycles their kinds, none in the last minute', function () {
    const plan = planActions(0, 30 * MIN, 3, 2 * MIN)
    expect(
      plan.slice(0, 4).map(p => [p.atMs / 1000, p.watcher, p.action])
    ).deep.equals([
      [60, 0, 'scrubLeft'],
      [100, 1, 'scrubRight'],
      [140, 2, 'rapidScrub'],
      [180, 0, 'scrubRight']
    ])
    expect(plan.every(p => p.atMs <= 29 * MIN)).equals(true)
    expect(plan.filter(p => p.watcher === 2)).length(14)
    expect(basicWindows(30)).deep.equals({
      baseline: [3 * MIN, 6 * MIN],
      final: [25 * MIN, 31 * MIN],
      slope: [3 * MIN, 31 * MIN]
    })
    expect(basicWindows(5).final).deep.equals([6 * MIN, 6 * MIN])
  })

  it('records every look, every scrub’s recovery, every frame and memory, and writes its report', async function () {
    const fake = fakeSession()
    await basicScrub({ minutes: 6, random: () => 0.5 }).run(fake.session)
    const steps = fake.steps
    const of = (surface: string, prefix: string): string[] =>
      steps
        .filter(s => s.surface === surface && s.step.startsWith(prefix))
        .map(s => s.verdict)
    expect(of('iphone', 'playing').every(v => v === 'passed')).equals(true)
    expect(of('android', 'playing').every(v => v === 'failed')).equals(true)
    expect(of('tv', 'playing').length).greaterThan(0)
    expect(of('tv', 'playing').every(v => v === 'blocked')).equals(true)
    expect(of('tv', 'recover-').every(v => v === 'blocked')).equals(true)
    expect(of('chrome', 'aligned').every(v => v === 'passed')).equals(true)
    // The iPhone's first scrub threw: its recovery is blocked, not a failure
    // of the app, and with its only scrubLeft untold the iPhone is blocked,
    // not passed on its looks.
    const untold = steps.find(
      s => s.surface === 'iphone' && s.verdict === 'blocked'
    )
    expect([untold?.step, untold?.observed]).deep.equals([
      'recover-scrubLeft',
      'the scrubLeft could not be done: no bar on screen'
    ])
    expect(verdicts(steps).iphone).equals('blocked')
    expect(of('android', 'recover-').every(v => v === 'failed')).equals(true)
    expect(of('chrome', 'recover-').length).greaterThan(0)
    expect(of('chrome', 'aligned-after-').every(v => v === 'passed')).equals(
      true
    )
    expect(fake.calls).includes('chrome jump')
    // Safari watches one angle in the page's player, and is scrubbed as the others are.
    expect(
      fake.calls.filter(call => call.startsWith('safari scrub')).length
    ).greaterThan(0)
    expect(of('safari', 'playing').length).greaterThan(0)
    const frames = steps.filter(s => s.step.startsWith('frames-'))
    expect(frames.map(s => [s.step, s.verdict])).deep.include.members([
      ['frames-SynthA', 'failed'],
      ['frames-SynthB', 'passed']
    ])
    expect(
      steps.find(s => s.step === 'memory-app.teamstation.develop')?.surface
    ).equals('android')
    const report = fake.written.get('basic-report.md')!
    expect(report).contains('# Basic streaming soak (6 minutes)')
    expect(report).contains('Verdict: **failed**')
    expect(report).match(/\| android \| 0\/\d+ \|/)
    expect(report).contains('## Chrome, every presented frame')
    expect(report).match(/SynthA frozen for/)
    // The logger goes in again with every drain, for a page loaded afresh.
    expect(fake.installs()).greaterThan(2)
    expect(
      fake.written.get('chrome-frames.jsonl')!.split('\n').length
    ).greaterThan(100)
  })

  it('leaves Chrome unlogged when told, with no Chrome section in its report', async function () {
    const fake = fakeSession()
    await basicScrub({ minutes: 3, random: () => 0.5, frameLog: false }).run(
      fake.session
    )
    expect(fake.installs()).equals(0)
    expect(fake.written.get('basic-report.md')).not.contains(
      'Chrome, every presented frame'
    )
  })

  it('keeps waiting through a look whose motion is unknown, and judges the next', async function () {
    const fake = fakeSession()
    const look = fake.session.look
    let scrubs = 0
    let unknownNext = false
    // Safari's first look after each scrub straddles the seek: motion unknown.
    fake.session.look = async w => {
      const seen = await look(w)
      if (w.role !== 'safari') return seen
      const now = fake.calls.filter(c => c.startsWith('safari ')).length
      if (now > scrubs) {
        scrubs = now
        unknownNext = true
      }
      if (unknownNext) {
        unknownNext = false
        return {
          ...seen,
          tiles: (seen.tiles ?? []).map(t => ({ ...t, advancing: null }))
        }
      }
      return seen
    }
    await basicScrub({ minutes: 6, random: () => 0.5 }).run(fake.session)
    const recoveries = fake.steps.filter(
      s => s.surface === 'safari' && s.step.startsWith('recover-')
    )
    expect(recoveries.length).greaterThan(0)
    expect(recoveries.every(s => s.verdict === 'passed')).equals(true)
  })

  it('blocks the memory of a sampler that threw or gave nothing, rather than leaving it out', async function () {
    const fake = fakeSession()
    fake.session.memory!.push(
      {
        name: 'ipad-xctrace',
        sample: async () => {
          throw new Error('no trace')
        }
      },
      { name: 'quiet', sample: async () => [] }
    )
    await basicScrub({ minutes: 6, random: () => 0.5 }).run(fake.session)
    const memory = fake.steps.filter(s => s.step === 'memory-sampler')
    expect(memory.map(s => [s.surface, s.verdict])).deep.equals([
      ['ipad-xctrace', 'blocked'],
      ['quiet', 'blocked']
    ])
    expect(memory[0].observed).contains('the sampler failed: sample: no trace')
    expect(memory[1].observed).contains('the sampler gave no samples')
  })

  it('fails a look with no player, a notice or a still angle, and blocks one whose motion is unknown', function () {
    const tile = (
      advancing: boolean | null,
      notice: string | null = null
    ): LookTile => ({
      angle: 'SynthA',
      advancing,
      notice,
      wallMs: null
    })
    expect(playState({ atMs: 0, tiles: null })).equals('failed')
    expect(playState({ atMs: 0, tiles: [] })).equals('failed')
    expect(
      playState({
        atMs: 0,
        tiles: [tile(null, 'Waiting for this camera to catch up to the game…')]
      })
    ).equals('failed')
    expect(playState({ atMs: 0, tiles: [tile(true), tile(false)] })).equals(
      'failed'
    )
    expect(playState({ atMs: 0, tiles: [tile(true), tile(null)] })).equals(
      'blocked'
    )
    expect(playState({ atMs: 0, tiles: [tile(true), tile(true)] })).equals(
      'passed'
    )
  })

  it('takes its watchers from BASIC_WATCHERS, in the soak’s order, or all of them', function () {
    expect(watchersFromEnv({})).equals(undefined)
    expect(watchersFromEnv({ BASIC_WATCHERS: ' ' })).equals(undefined)
    expect(
      watchersFromEnv({ BASIC_WATCHERS: 'safari, iphone,chrome' })
    ).deep.equals(['iphone', 'chrome', 'safari'])
    expect(() => watchersFromEnv({ BASIC_WATCHERS: 'ipad' })).throws(
      'BASIC_WATCHERS: no watcher "ipad"'
    )
    expect(
      basicScrub({ minutes: 1, watchers: ['chrome'] }).setup.watchers
    ).deep.equals(['chrome'])
  })

  it('reports a clean run as passed, with no Chrome section when Chrome did not log', function () {
    const report = basicReport(
      [
        {
          atMs: T0,
          step: 'playing',
          surface: 'iphone',
          expected: '',
          observed: '',
          verdict: 'passed'
        },
        {
          atMs: T0,
          step: 'recover-scrubLeft',
          surface: 'iphone',
          expected: '',
          observed: 'scrub to 0.50; moving after 2.4 s: …',
          verdict: 'passed'
        }
      ],
      [],
      30
    )
    expect(report).contains('Verdict: **passed**')
    expect(report).contains('| iphone | 1/1 | – | 1/1 | 2.4 s |')
    expect(report).not.contains('every presented frame')
    expect(report).not.contains('## This Mac')
  })

  it("reads this machine's load every 30 s, and says whether it kept up", async function () {
    const fake = fakeSession()
    let reading = 0
    await basicScrub({
      minutes: 6,
      random: () => 0.5,
      machine: { load: () => [3, 5, 21][reading++ % 3], cores: 18 }
    }).run(fake.session)
    const loads = fake.written
      .get('mac-load.jsonl')!
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { atMs: number; load: number })
    expect(loads.length).greaterThanOrEqual(12)
    expect(loads[1].atMs - loads[0].atMs).greaterThanOrEqual(30_000)
    expect(fake.written.get('basic-report.md')).contains(
      `## This Mac\n\n${machineLine({ cores: 18, loads: loads.map(row => row.load) })}`
    )
    expect(machineLine({ cores: 18, loads: [3, 5, 4] })).equals(
      'Load average (1 min), every 30 s: median 4.0, highest 5.0, on 18 cores; under the core count throughout.'
    )
    expect(machineLine({ cores: 18, loads: [3, 21, 25] })).equals(
      'Load average (1 min), every 30 s: median 21.0, highest 25.0, on 18 cores; over it in 2 of 3 readings.'
    )
  })
})
