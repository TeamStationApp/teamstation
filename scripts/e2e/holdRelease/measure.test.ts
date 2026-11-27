import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { type Edge, type Sample, screenshotClocks } from './frames'
import { measure } from './measure'

const hold = { x: 0.85, y: 0.4 }
const tap = { x: 0.5, y: 0.4 }
/** Device uptime wraps the strip's 24 bits during the contact. */
function trial(withTap = true): Sample[] {
  const wrap = 2 ** 24
  const time = (t: number): number => (wrap - 2000 + t) % wrap
  const edge = (p: typeof tap, t: number, up: boolean): Edge => ({
    ...p,
    time: time(t),
    up
  })
  const edges = [
    edge(hold, 0, false),
    edge(hold, 5000, true),
    edge(tap, 5040, false),
    edge(tap, 5100, true)
  ]
  const result: Sample[] = []
  for (let t = -500; t <= 10500; t += 20) {
    const cam = Math.round(
      t < 5000 ? t * 0.25 : 1250 + (withTap ? 0 : t - 5000)
    )
    result.push({
      time: time(t),
      pts: t + 500,
      sequence:
        t < 0 ? 0 : t < 5000 ? 1 : !withTap || t < 5040 ? 2 : t < 5100 ? 3 : 4,
      edges,
      slow: t >= 500 && t < 5060,
      paused: withTap && t >= 5140,
      cameras: [cam, cam + 1000]
    })
  }
  return result
}
describe('native hold screen measurement', function () {
  it('reads independent fixture clocks from the full-resolution hub screenshot', function () {
    const image = {
      width: 1280,
      height: 1440,
      data: new Uint8Array(1280 * 1440 * 4)
    }
    const tiles = [
      { x: 0, y: 0, width: 640, height: 360 },
      { x: 0, y: 360, width: 640, height: 360 }
    ]
    const clocks = [37, 0xffff1234]
    for (const [camera, clock] of clocks.entries())
      for (let bit = 0; bit <= 32; bit++) {
        if (bit !== 32 && ((clock >>> bit) & 1) === 0) continue
        const pixel = ((664 + 720 * camera) * image.width + 56 + bit * 36) * 4
        image.data.fill(255, pixel, pixel + 4)
      }
    assert.deepEqual(
      screenshotClocks(image, { x: 0, y: 0, width: 640, height: 720 }, tiles),
      clocks
    )
  })
  it('bounds release and tap against their own native edges across clock rollover', function () {
    const result = measure(trial(), 5000, hold, tap)
    assert.equal(result.releaseMs, 114)
    assert.equal(result.tapMs, 154)
    assert.equal(result.gapMs, 40)
    assert.deepEqual(result.heldRates, [0.25, 0.25])
  })
  it('excludes an encoder startup reversal before the reference, and rejects it inside the measured window', function () {
    const recording = trial()
    const first = recording[0]
    recording.unshift(
      { ...first, time: first.time - 1500, pts: -100 },
      { ...first, time: first.time - 1520, pts: -80 }
    )
    assert.equal(measure(recording, 5000, hold, tap).tapMs, 154)
    const previous = recording.find(f => f.pts === 200)!
    const damaged = recording.find(f => f.pts === 220)!
    damaged.time = previous.time - 5
    assert.throws(
      () => measure(recording, 5000, hold, tap),
      /invalid display clock/
    )
  })
  it('checks that every camera resumes during an independent lift-only run', function () {
    const movie = trial(false)
    assert.deepEqual(measure(movie, 5000, hold).afterRates, [1, 1])
    for (const f of movie) f.cameras[1] = 1234
    assert.throws(() => measure(movie, 5000, hold), /held camera rates/)
  })
  it('rejects a camera that stays at quarter speed for the first half second after lift', function () {
    const movie = trial(false)
    for (const frame of movie) {
      const sinceLift = frame.pts - 5500
      if (sinceLift >= 0)
        frame.cameras[1] =
          2250 +
          Math.round(
            Math.min(sinceLift, 500) * 0.25 + Math.max(0, sinceLift - 500)
          )
    }
    assert.throws(
      () => measure(movie, 5000, hold),
      /camera 2 did not visibly resume/
    )
  })
  it('rejects pictures that visibly accelerate while their native clock is frozen', function () {
    const movie = trial(false)
    for (const f of movie) {
      if (f.pts >= 5580 && f.pts <= 5820)
        f.time = movie.find(s => s.pts === 5560)!.time
      if (f.pts >= 5500 && f.pts < 5640) f.cameras[1] = 2250
    }
    assert.throws(() => measure(movie, 5000, hold), /resume upper bound/)
  })
  it('rejects a late visible release, a missing camera and a missing input', function () {
    const late = trial()
    for (const f of late) if (f.pts >= 5500 && f.pts < 5800) f.slow = true
    assert.throws(() => measure(late, 5000, hold, tap), /upper bound/)
    const hidden = trial()
    for (const f of hidden) f.cameras[0] = null
    assert.throws(() => measure(hidden, 5000, hold, tap), /unreadable/)
    const lost = trial()
    lost.at(-1)!.sequence = 3
    assert.throws(() => measure(lost, 5000, hold, tap), /exactly the hold/)
  })
})
