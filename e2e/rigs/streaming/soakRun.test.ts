import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import type { MemorySample, RecordedEvent, RecordedProbe } from './soakRecords'
import { readJsonl } from './soakRecords'
import { runSoak, type SoakParts, type SoakPublisher } from './soakRun'
import {
  ANGLES,
  type Publisher,
  soakSchedule,
  type SoakSurface,
  SURFACES
} from './soakSchedule'
import type { SoakSurfaceDriver, SurfaceProbe } from './surfaces/surface'

/** A clock that moves only when the run sleeps, letting queued work run between. */
function virtualClock(): {
  now: () => number
  sleep: (ms: number) => Promise<void>
} {
  let t = Date.UTC(2026, 10, 12, 20)
  return {
    now: () => t,
    sleep: async ms => {
      t += ms
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
  }
}

function fakeSurface(
  name: string,
  calls: string[],
  fails?: string,
  notes: string[] = []
): SoakSurfaceDriver {
  const did =
    (what: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push(
        `${name}:${what}${args.length > 0 ? `:${String(args[0])}` : ''}`
      )
      if (what === fails) throw new Error(`${name} cannot ${what}`)
    }
  return {
    name,
    join: did('join'),
    cut: did('cut'),
    scrub: did('scrub'),
    rapidScrub: did('rapidScrub'),
    skip: did('skip'),
    slowMotion: did('slowMotion'),
    jumpToPresent: did('jumpToPresent'),
    exitAndReenter: did('exitAndReenter'),
    relaunch: did('relaunch'),
    takeNotes: () => notes.splice(0),
    probe: async (): Promise<SurfaceProbe> => {
      if (fails === 'probe') throw new Error('no answer')
      return {
        tiles: ANGLES.map(angle => ({ angle, advancing: true, notice: null })),
        bar: 1,
        foreground: true
      }
    }
  }
}

function parts(options: {
  fails?: Partial<Record<SoakSurface, string>>
  samplerFails?: boolean
  notes?: Partial<Record<SoakSurface, string[]>>
}): { parts: SoakParts; calls: string[]; stopped: string[] } {
  const calls: string[] = []
  const stopped: string[] = []
  const clock = virtualClock()
  const surfaces = Object.fromEntries(
    SURFACES.map(name => [
      name,
      fakeSurface(name, calls, options.fails?.[name], options.notes?.[name])
    ])
  ) as Record<SoakSurface, SoakSurfaceDriver>
  let front: 'iphone-app' | 'iphone-safari' = 'iphone-app'
  const publisher = (name: Publisher): SoakPublisher => ({
    start: async () => {
      calls.push(`${name}:start`)
    },
    stop: async () => {
      stopped.push(name)
    },
    ...(name === 'publisherC'
      ? {
          cut: async (seconds: number) => {
            calls.push(`${name}:cut:${seconds}`)
          }
        }
      : {})
  })
  return {
    calls,
    stopped,
    parts: {
      schedule: soakSchedule({ minutes: 12 }),
      runDir: join(mkdtempSync(join(tmpdir(), 'soak-run-')), 'run'),
      surfaces,
      iphone: {
        get surface() {
          return front
        },
        switchTo: async to => {
          calls.push(`iphone:switch:${to}`)
          front = to === 'app' ? 'iphone-app' : 'iphone-safari'
          return { newTab: to === 'safari' }
        }
      },
      publishers: {
        publisherA: publisher('publisherA'),
        publisherB: publisher('publisherB'),
        publisherC: publisher('publisherC')
      },
      samplers: [
        {
          name: 'ipad',
          start: async () => {
            if (options.samplerFails === true) throw new Error('no trace')
          },
          sample: async (now: number): Promise<MemorySample[]> => [
            { device: 'ipad', process: 'app', atMs: now, bytes: 200e6 }
          ],
          stop: async () => {
            stopped.push('sampler')
            return []
          }
        }
      ],
      provenance: { ref: 'test' },
      ...clock
    }
  }
}

describe('the soak run', function () {
  this.timeout(60000)

  it('plays a compressed schedule on every surface, then reports', async function () {
    const { parts: run, calls, stopped } = parts({})
    const report = await runSoak(run)
    const events = readJsonl<RecordedEvent>(join(run.runDir, 'events.jsonl'))
    const probes = readJsonl<RecordedProbe>(join(run.runDir, 'probes.jsonl'))
    const memory = readJsonl<MemorySample>(join(run.runDir, 'memory.jsonl'))
    expect(events[0].action).equals('runStart')
    expect(events[0].args?.provenance).deep.equals({ ref: 'test' })
    const scheduled = run.schedule.events.filter(
      event => event.action !== 'stopPublishers'
    )
    const done = events.filter(
      event =>
        !['runStart', 'cameraCutBack', 'stopPublisher'].includes(event.action)
    )
    expect(done).has.length(scheduled.length)
    expect(done.every(event => event.error == null)).equals(true)
    const cuts = scheduled.filter(event => event.action === 'cameraCut')
    const backs = events.filter(event => event.action === 'cameraCutBack')
    expect(backs).has.length(cuts.length)
    expect(backs[0].args?.angle).equals(cuts[0].args.angle)
    // Each back comes 20 s after its cut finished, on the same surface.
    const firstCut = events.find(event => event.action === 'cameraCut')!
    expect(backs[0].atMs - (firstCut.doneMs ?? 0)).greaterThanOrEqual(20000)
    expect(
      calls.filter(call => call.startsWith('publisherC:cut:'))
    ).deep.equals(run.schedule.cuts.map(cut => `publisherC:cut:${cut.seconds}`))
    expect(calls).includes('iphone:switch:safari')
    for (const surface of ['android', 'ipad', 'tv', 'chrome']) {
      expect(
        probes.filter(probe => probe.surface === surface).length,
        surface
      ).greaterThan(10)
    }
    expect(probes.some(probe => probe.surface === 'iphone-safari')).equals(true)
    expect(memory.length).greaterThan(5)
    expect(stopped.sort()).deep.equals([
      'publisherA',
      'publisherB',
      'publisherC',
      'sampler'
    ])
    expect(report.verdict).not.equals(undefined)
    expect(existsSync(join(run.runDir, 'report.md'))).equals(true)
    expect(existsSync(join(run.runDir, 'memory.csv'))).equals(true)
  })

  it("puts a driver's notes on the event it made them during, once", async function () {
    const { parts: run } = parts({
      notes: { android: ['rejoined: the full-screen player was not up'] }
    })
    await runSoak(run)
    const events = readJsonl<RecordedEvent>(join(run.runDir, 'events.jsonl'))
    const noted = events.filter(event => event.notes != null)
    expect(noted).length(1)
    expect(noted[0].target).equals('android')
    expect(noted[0].notes).deep.equals([
      'rejoined: the full-screen player was not up'
    ])
  })

  it('records a surface that throws and keeps going, and still tears down', async function () {
    const { parts: run, stopped } = parts({
      fails: { tv: 'relaunch', chrome: 'probe' },
      samplerFails: true
    })
    await runSoak(run)
    const events = readJsonl<RecordedEvent>(join(run.runDir, 'events.jsonl'))
    const probes = readJsonl<RecordedProbe>(join(run.runDir, 'probes.jsonl'))
    const relaunch = events.find(
      event => event.target === 'tv' && event.action === 'relaunch'
    )
    expect(relaunch?.error).equals('tv cannot relaunch')
    expect(
      events.some(event => event.target === 'tv' && event.action === 'skip')
    ).equals(true)
    const chrome = probes.filter(probe => probe.surface === 'chrome')
    expect(chrome.length).greaterThan(0)
    expect(chrome.every(probe => probe.tiles === null)).equals(true)
    expect(chrome[0].reason).includes('probe threw')
    expect(events.find(event => event.action === 'samplerStart')?.error).equals(
      'no trace'
    )
    expect(stopped).includes('publisherC')
    expect(stopped).includes('sampler')
  })

  it('stops the publishers and samplers when the run itself breaks', async function () {
    const { parts: run, stopped } = parts({})
    let sleeps = 0
    const sleep = run.sleep!
    run.sleep = async ms => {
      if (++sleeps === 30) throw new Error('clock broke')
      await sleep(ms)
    }
    let thrown: unknown
    await runSoak(run).catch((error: unknown) => (thrown = error))
    expect((thrown as Error).message).equals('clock broke')
    expect(stopped.sort()).deep.equals([
      'publisherA',
      'publisherB',
      'publisherC',
      'sampler'
    ])
  })

  it('keeps to the schedule while a sampler is still busy', async function () {
    const { parts: run } = parts({})
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let calls = 0
    run.samplers.push({
      name: 'slow',
      sample: async () => {
        calls++
        await held
        return []
      }
    })
    const stop = run.publishers.publisherA.stop
    run.publishers.publisherA.stop = async () => {
      release()
      await stop()
    }
    await runSoak(run)
    const events = readJsonl<RecordedEvent>(join(run.runDir, 'events.jsonl'))
    const scheduled = run.schedule.events.filter(
      event => event.action !== 'stopPublishers'
    )
    const done = events.filter(
      event =>
        !['runStart', 'cameraCutBack', 'stopPublisher'].includes(event.action)
    )
    expect(done).has.length(scheduled.length)
    expect(calls).equals(1)
  })

  it('records a publisher that cannot be cut', async function () {
    const { parts: run } = parts({})
    delete run.publishers.publisherC.cut
    await runSoak(run)
    const events = readJsonl<RecordedEvent>(join(run.runDir, 'events.jsonl'))
    expect(events.find(event => event.action === 'syntheticCut')?.error).equals(
      'publisherC cannot be cut'
    )
  })
})
