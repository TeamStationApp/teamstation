import { Script } from 'node:vm'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  analyseFrames,
  clockSamplePoints,
  digitPatterns,
  FRAME_DRAIN_SCRIPT,
  frameLogScript,
  parseFrames,
  type PresentedFrame
} from './chromeFrames'
import { drawnPicture } from './clockReader.test'

function frame(
  angle: string,
  displayMs: number,
  clockMsOfDay: number | null
): PresentedFrame {
  return { angle, presented: 0, mediaTime: 0, displayMs, clockMsOfDay }
}

/** 30 frames a second from `fromMs` to `toMs`, each showing what `clockAt` says. */
function run(
  angle: string,
  fromMs: number,
  toMs: number,
  clockAt: (ms: number) => number | null
): PresentedFrame[] {
  const out: PresentedFrame[] = []
  for (let at = fromMs; at < toMs; at += 33)
    out.push(frame(angle, at, clockAt(at)))
  return out
}

describe("Chrome's frame log", function () {
  it('reads the clock of a quarter-size frame at the points the page samples', function () {
    const picture = drawnPicture('SYNTHA', 4)
    const patterns = digitPatterns()
    const ink = (x: number, y: number): boolean => {
      const at = (y * picture.width + x) * 4
      const [r, g, b] = [
        picture.data[at],
        picture.data[at + 1],
        picture.data[at + 2]
      ]
      return r > 150 && g > 100 && b < 110 && r - b > 90
    }
    const digits = clockSamplePoints().map(
      points =>
        patterns[points.map(([x, y]) => (ink(x, y) ? '1' : '0')).join('')]
    )
    // drawnPicture shows 17:04:05.678.
    expect(digits.join('')).equals('170405678')
  })

  it('installs a logger that parses, and a drain that hands over and empties the log', function () {
    const script = frameLogScript()
    expect(() => new Script(script)).not.throws()
    expect(script).contains('requestVideoFrameCallback')
    expect(FRAME_DRAIN_SCRIPT).contains('splice(0, log.length)')
    expect(
      parseFrames(
        JSON.stringify([
          ['SynthA', 3, 1.5, 1000, -1],
          ['SynthB', 4, 2, 1033, 61445678]
        ])
      )
    ).deep.equals([
      {
        angle: 'SynthA',
        presented: 3,
        mediaTime: 1.5,
        displayMs: 1000,
        clockMsOfDay: null
      },
      {
        angle: 'SynthB',
        presented: 4,
        mediaTime: 2,
        displayMs: 1033,
        clockMsOfDay: 61445678
      }
    ])
    expect(parseFrames([])).deep.equals([])
  })

  it('finds a stall, a frozen picture and the spread, and leaves the quiet windows out', function () {
    const clock = (lag: number) => (ms: number) => ms - lag
    const frames = [
      // SynthA plays, then presents nothing for 3 s (a stall), then plays on.
      ...run('SynthA', 0, 10_000, clock(0)),
      ...run('SynthA', 13_000, 20_000, clock(0)),
      // SynthB plays 200 ms behind, then its picture freezes for 4 s.
      ...run('SynthB', 0, 8_000, clock(200)),
      ...run('SynthB', 8_000, 12_000, () => 7_800),
      ...run('SynthB', 12_000, 20_000, clock(200)),
      // SynthC stalls only inside a quiet window.
      ...run('SynthC', 0, 15_000, clock(0)),
      ...run('SynthC', 17_000, 20_000, clock(0)),
      frame('SynthD', 500, null)
    ]
    const analysis = analyseFrames(frames, [[14_000, 18_000]])
    const byAngle = Object.fromEntries(analysis.angles.map(a => [a.angle, a]))
    expect(byAngle.SynthA).deep.include({ stalls: 1, frozen: 0 })
    expect(byAngle.SynthA.longestMs).closeTo(3000, 40)
    expect(byAngle.SynthB).deep.include({ stalls: 0, frozen: 1 })
    expect(byAngle.SynthB.longestMs).closeTo(4000, 40)
    expect(byAngle.SynthC).deep.include({ stalls: 0, frozen: 0 })
    expect(byAngle.SynthD).deep.include({ frames: 1, readable: 0 })
    expect(analysis.gaps.map(g => [g.angle, g.kind])).deep.equals([
      ['SynthA', 'stall'],
      ['SynthB', 'frozen']
    ])
    const early = analysis.spreads.find(s => s.atMs === 2000)!
    expect(early.spreadMs).closeTo(200, 40)
    expect(
      analysis.spreads.every(s => s.atMs < 14_000 || s.atMs >= 18_000)
    ).equals(true)
  })

  it('stalls an angle that stops for good until the end, and one that never presented a frame', function () {
    const frames = [
      ...run('SynthA', 0, 20_000, ms => ms),
      ...run('SynthB', 0, 6_000, ms => ms)
    ]
    const analysis = analyseFrames(frames, [], {
      startMs: 0,
      endMs: 20_000,
      expected: ['SynthA', 'SynthB', 'SynthC']
    })
    const byAngle = Object.fromEntries(analysis.angles.map(a => [a.angle, a]))
    expect(byAngle.SynthA).deep.include({ stalls: 0 })
    expect(byAngle.SynthB).deep.include({ stalls: 1 })
    expect(byAngle.SynthB.longestMs).closeTo(14_000, 40)
    expect(byAngle.SynthC).deep.equals({
      angle: 'SynthC',
      frames: 0,
      readable: 0,
      stalls: 1,
      frozen: 0,
      longestMs: 20_000
    })
    expect(analysis.gaps.map(g => [g.angle, g.kind])).deep.equals([
      ['SynthB', 'stall'],
      ['SynthC', 'stall']
    ])
  })
})
