import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { after, before, describe, it } from 'mocha'

import {
  analyzeMotion,
  diffSeries,
  type MotionSample,
  parseYavg,
  samplesOf
} from './motion'

/** Diffs at fixed 500 ms spacing: `true` moved, `false` stood still. */
function series(moves: boolean[], startMs = 0, stepMs = 500): MotionSample[] {
  return [
    { atMs: startMs, diff: null },
    ...moves.map((moved, index) => ({
      atMs: startMs + (index + 1) * stepMs,
      diff: moved ? 12 : 0.1
    }))
  ]
}

describe('playback probe: motion', function () {
  this.timeout(60000)
  let dir: string

  before(function () {
    dir = mkdtempSync(join(tmpdir(), 'pbr-motion-'))
    // Seven distinct pattern frames, then a sequence that holds frame 4.
    execFileSync('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=10',
      '-frames:v',
      '7',
      join(dir, 'src-%02d.png')
    ])
    const order = [1, 2, 3, 4, 4, 4, 4, 5, 6, 7]
    order.forEach((frame, index) => {
      copyFileSync(
        join(dir, `src-${String(frame).padStart(2, '0')}.png`),
        join(dir, `${String(index + 1).padStart(6, '0')}.png`)
      )
    })
  })

  after(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  it('measures each picture against the one before it, inside the crop', async function () {
    const diffs = await diffSeries(
      { pattern: join(dir, '%06d.png') },
      { x: 0, y: 0, w: 320, h: 180 }
    )
    assert.equal(diffs.length, 9)
    const still = diffs.map(diff => diff <= 0.6)
    assert.deepEqual(still, [
      false,
      false,
      false,
      true,
      true,
      true,
      false,
      false,
      false
    ])
  })

  it('finds the held frame as a freeze from real pictures', async function () {
    const diffs = await diffSeries(
      { pattern: join(dir, '%06d.png') },
      { x: 10.4, y: 10.6, w: 101, h: 61 }
    )
    const times = Array.from({ length: 10 }, (_, index) => index * 250)
    const verdict = analyzeMotion(samplesOf(times, diffs), 0)
    assert.equal(verdict.startMs, 250)
    assert.deepEqual(verdict.freezes, [{ fromMs: 750, toMs: 1500 }])
    assert.equal(verdict.longestFreezeMs, 750)
  })

  it('reads a video too', async function () {
    const video = join(dir, 'clip.mp4')
    execFileSync('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=10',
      '-t',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-y',
      video
    ])
    const diffs = await diffSeries({ video }, { x: 0, y: 0, w: 320, h: 180 })
    assert.equal(diffs.length, 9)
    assert.ok(diffs.every(diff => diff > 0.6))
  })

  it('parses only the YAVG lines', function () {
    assert.deepEqual(
      parseYavg(
        'frame:0 pts:0\nlavfi.signalstats.YAVG=0.5\nframe:1\nlavfi.signalstats.YAVG=12.25\nlavfi.signalstats.YMIN=0'
      ),
      [0.5, 12.25]
    )
  })

  it('refuses a series that does not fit its pictures', function () {
    assert.throws(() => samplesOf([0, 500, 1000], [1]), /3 pictures need 2/)
    assert.deepEqual(samplesOf([], []), [])
  })

  it('starts at the first change that keeps changing after the release', function () {
    // A seek lands one new still frame at 1000, then playback from 2500.
    const samples = series([false, true, false, false, true, true, true])
    const verdict = analyzeMotion(samples, 400)
    assert.equal(verdict.startMs, 2500 - 400)
    assert.deepEqual(verdict.freezes, [])
  })

  it('does not take a picture arriving, then standing still, for playback', function () {
    // Black, then the loading state, then the first frame — and paused.
    const verdict = analyzeMotion(
      series([true, true, false, false, false, false]),
      0
    )
    assert.equal(verdict.startMs, null)
  })

  it('ignores motion from before the release', function () {
    const samples = series([true, true, false, false, false, false])
    assert.equal(analyzeMotion(samples, 1200).startMs, null)
  })

  it('reports no start when the picture never moves again', function () {
    const verdict = analyzeMotion(series([false, false, false]), 0)
    assert.deepEqual(verdict, {
      startMs: null,
      freezes: [],
      longestFreezeMs: 0
    })
  })

  it('reports a freeze in the middle and one running to the end', function () {
    const samples = series([
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      false,
      false
    ])
    const verdict = analyzeMotion(samples, 0)
    assert.equal(verdict.startMs, 500)
    assert.deepEqual(verdict.freezes, [
      { fromMs: 1500, toMs: 3000 },
      { fromMs: 4000, toMs: 5000 }
    ])
    assert.equal(verdict.longestFreezeMs, 1500)
  })

  it('does not call one repeated picture at a 500 ms spacing a freeze', function () {
    const verdict = analyzeMotion(
      series([true, true, true, false, true, true]),
      0
    )
    assert.deepEqual(verdict.freezes, [])
  })
})
