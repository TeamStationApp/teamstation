import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  defaultKind,
  judgeMemory,
  median,
  memoryCsv,
  slopeMBh,
  splitLifetimes,
  windowsFromPhases
} from './soakMemory'
import type { MemorySample } from './soakRecords'
import { soakSchedule } from './soakSchedule'

const T0 = 5_000_000
const MIN = 60_000
const MB = 1e6

/** One sample a minute from `from` to `to` minutes, bytes from the function. */
function series(
  device: string,
  process: string,
  from: number,
  to: number,
  bytesAt: (minute: number) => number,
  pid?: number
): MemorySample[] {
  const out: MemorySample[] = []
  for (let minute = from; minute <= to; minute++) {
    out.push({
      device,
      process,
      atMs: T0 + minute * MIN,
      bytes: bytesAt(minute),
      pid
    })
  }
  return out
}

/** A seeded wobble, so slopes are taken over noise. */
function noise(minute: number): number {
  return Math.sin(minute * 12.9898) * 4 * MB
}

describe('soak memory', function () {
  it('takes medians of a window', function () {
    expect(median([])).equals(undefined)
    expect(median([3, 1, 2])).equals(2)
    expect(median([4, 1, 3, 2])).equals(2.5)
  })

  it('finds the slope of a noisy series', function () {
    const samples = series(
      'ipad',
      'TeamStation',
      0,
      120,
      minute => 200 * MB + (minute / 60) * 20 * MB + noise(minute)
    )
    expect(slopeMBh(samples)).closeTo(20, 1.5)
    expect(slopeMBh(samples.slice(0, 1))).equals(undefined)
    expect(slopeMBh([samples[0], { ...samples[0] }])).equals(undefined)
  })

  it('passes a flat process and reads its window medians', function () {
    const [verdict] = judgeMemory(
      series('ipad', 'TeamStation', 0, 120, minute => 300 * MB + noise(minute)),
      { runStartMs: T0 }
    )
    expect(verdict.verdict).equals('passed')
    expect(verdict.kind).equals('app')
    expect(verdict.baselineMedian! / MB).closeTo(300, 4)
    expect(verdict.growth).closeTo(0, 0.03)
  })

  it('passes growth just under 15 % and fails it just over', function () {
    // A step at minute 100, so the slope stays small and growth alone decides.
    const step = (factor: number) => (minute: number) =>
      minute >= 100 ? 400 * MB * factor : 400 * MB
    const under = judgeMemory(
      series('tv', 'TeamStation TV', 0, 120, step(1.149)),
      {
        runStartMs: T0,
        limits: {
          growth: 0.15,
          appSlopeMBh: 1000,
          browserSlopeMBh: 1000,
          minLifetimeMs: 20 * MIN
        }
      }
    )[0]
    expect(under.verdict).equals('passed')
    const over = judgeMemory(
      series('tv', 'TeamStation TV', 0, 120, step(1.151)),
      {
        runStartMs: T0,
        limits: {
          growth: 0.15,
          appSlopeMBh: 1000,
          browserSlopeMBh: 1000,
          minLifetimeMs: 20 * MIN
        }
      }
    )[0]
    expect(over.verdict).equals('failed')
    expect(over.reason).match(/grew 15\.1 %/)
  })

  it('holds an app to 30 MB/h and a browser tab to 60 MB/h', function () {
    const climbing = (process: string, device = 'phone'): MemorySample[] =>
      series(
        device,
        process,
        0,
        120,
        minute => 2000 * MB + (minute / 60) * 40 * MB + noise(minute)
      )
    const app = judgeMemory(climbing('TeamStation'), { runStartMs: T0 })[0]
    expect(app.verdict).equals('failed')
    expect(app.reason).match(/slope/)
    const tab = judgeMemory(climbing('renderer', 'chrome'), {
      runStartMs: T0
    })[0]
    expect(tab.kind).equals('browser')
    expect(tab.verdict).equals('passed')
  })

  it('splits lifetimes at relaunches and pid changes, and judges the longest', function () {
    const before = series('android', 'TeamStation', 0, 39, () => 500 * MB, 100)
    // After the relaunch it starts small and stays flat for 80 minutes.
    const after = series('android', 'TeamStation', 40, 120, () => 300 * MB, 200)
    const lifetimes = splitLifetimes([...after, ...before])
    expect(lifetimes.map(life => life.samples.length)).deep.equals([40, 81])
    const byRelaunch = splitLifetimes(
      [...before, ...after].map(sample => ({ ...sample, pid: undefined })),
      [T0 + 39.5 * MIN]
    )
    expect(byRelaunch).length(2)
    const [verdict] = judgeMemory([...before, ...after], { runStartMs: T0 })
    expect(verdict.judged).equals(1)
    expect(verdict.verdict).equals('passed')
    expect(verdict.baselineMedian).equals(300 * MB)
    expect(verdict.lifetimes).length(2)
  })

  it('judges a lifetime that ends early against its own last ten minutes', function () {
    const early = series(
      'ipad',
      'TeamStation',
      0,
      60,
      minute => (minute < 50 ? 300 : 400) * MB
    )
    const [verdict] = judgeMemory(early, {
      runStartMs: T0,
      limits: {
        growth: 0.15,
        appSlopeMBh: 1000,
        browserSlopeMBh: 1000,
        minLifetimeMs: 20 * MIN
      }
    })
    expect(verdict.finalMedian).equals(400 * MB)
    expect(verdict.verdict).equals('failed')
  })

  it('blocks a process with no 20-minute lifetime, and calls the stack informational', function () {
    const short = series('ipad', 'TeamStation', 0, 15, () => MB)
    expect(judgeMemory(short, { runStartMs: T0 })[0].verdict).equals('blocked')
    const stackShort = series('stack', 'api', 0, 5, () => MB)
    expect(judgeMemory(stackShort, { runStartMs: T0 })[0].verdict).equals(
      'informational'
    )
    const stack = series('stack', 'ingest', 0, 120, minute => minute * 10 * MB)
    const [server] = judgeMemory(stack, { runStartMs: T0 })
    expect(server.kind).equals('server')
    expect(server.verdict).equals('informational')
  })

  it('blocks a lifetime with an empty window', function () {
    const gap = [
      ...series('ipad', 'TeamStation', 0, 5, () => MB),
      ...series('ipad', 'TeamStation', 30, 120, () => MB)
    ].map(sample => ({ ...sample, pid: 7 }))
    const [verdict] = judgeMemory(gap, { runStartMs: T0 })
    expect(verdict.verdict).equals('blocked')
    expect(verdict.reason).match(/window/)
  })

  it('judges the iPhone app and Safari only on their own time in front', function () {
    const ranges = (pairs: Array<[number, number]>): Array<[number, number]> =>
      pairs.map(([from, to]) => [T0 + from * MIN, T0 + to * MIN])
    const app = ranges([
      [0, 20],
      [40, 60],
      [80, 100]
    ])
    const safari = ranges([
      [20, 40],
      [60, 80],
      [100, 120]
    ])
    // In the background each balloons; in front each is flat.
    const inFront = (r: Array<[number, number]>, minute: number): boolean =>
      r.some(
        ([from, to]) => T0 + minute * MIN >= from && T0 + minute * MIN < to
      )
    const samples = [
      ...series(
        'iphone',
        'TeamStation',
        0,
        120,
        minute => (inFront(app, minute) ? 250 : 900) * MB
      ),
      ...series(
        'iphone',
        'com.apple.WebKit.WebContent',
        0,
        120,
        minute => (inFront(safari, minute) ? 400 : 50) * MB
      )
    ]
    const verdicts = judgeMemory(samples, {
      runStartMs: T0,
      foreground: {
        'iphone/TeamStation': app,
        'iphone/com.apple.WebKit.WebContent': safari
      }
    })
    const appVerdict = verdicts.find(v => v.process === 'TeamStation')!
    expect(appVerdict.verdict).equals('passed')
    expect(appVerdict.baselineMedian).equals(250 * MB)
    const safariVerdict = verdicts.find(v => v.process !== 'TeamStation')!
    expect(safariVerdict.kind).equals('browser')
    expect(safariVerdict.verdict).equals('passed')
    expect(safariVerdict.finalMedian).equals(400 * MB)
  })

  it('writes the curves as CSV, and takes windows from a schedule', function () {
    const csv = memoryCsv(
      [
        { device: 'b', process: 'x', atMs: T0 + MIN, bytes: 2 },
        { device: 'a', process: 'y,"z"', atMs: T0 + 2 * MIN, bytes: 1, pid: 9 },
        { device: 'a', process: 'y,"z"', atMs: T0, bytes: 3 }
      ],
      T0
    )
    expect(csv.split('\n')).deep.equals([
      'device,process,minute,bytes,pid',
      'a,"y,""z""",0.00,3,',
      'a,"y,""z""",2.00,1,9',
      'b,x,1.00,2,',
      ''
    ])
    const windows = windowsFromPhases(soakSchedule().phases)
    expect(windows.baseline).deep.equals([10 * MIN, 15 * MIN])
    expect(windows.final).deep.equals([110 * MIN, 120 * MIN])
    expect(
      defaultKind({ device: 'chrome', process: 'jsHeap', atMs: 0, bytes: 0 })
    ).equals('browser')
  })
})
