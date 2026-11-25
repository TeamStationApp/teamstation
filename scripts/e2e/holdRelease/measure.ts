import assert from 'node:assert/strict'

import { DISPLAY_MS, elapsed, type Point, type Sample } from './frames'

function median(values: number[]): number {
  assert.ok(values.length >= 3, 'too few readable frames')
  const sorted = values.sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

interface Measurement {
  duration: number
  releaseMs: number
  gapMs?: number
  tapMs?: number
  uncertainty: number
  resumedMs?: number[]
  heldRates: number[]
  afterRates: number[]
}

export function measure(
  frames: Sample[],
  requested: number,
  hold: Point,
  tap?: Point
): Measurement {
  assert.ok(frames.length > 0, 'native input strip missing')
  const first = frames[0]
  const last = frames[frames.length - 1]
  const count = tap == null ? 2 : 4
  assert.equal(
    last.sequence - first.sequence,
    count,
    'expected exactly the hold and requested follow-up input'
  )
  const edges = Array.from(
    { length: count },
    (_, i) => last.edges[(first.sequence + i) % 4]
  )
  const [down, up, contact] = edges
  const close = (a: Point, b: Point): boolean =>
    Math.abs(a.x - b.x) < 0.04 && Math.abs(a.y - b.y) < 0.04
  assert.ok(
    !down.up && up.up && close(down, hold) && close(up, hold),
    'hold edges outside target'
  )
  const duration = elapsed(up.time, down.time)
  assert.ok(
    duration >= requested - 35 && duration <= requested + 1000,
    `actual hold was ${duration} ms`
  )
  const time = (f: Sample): number => elapsed(f.time, down.time)
  // The streamer can flush stale initialization frames while its encoder
  // starts. Measure the last second of the validated moving reference and
  // every frame from the first contact onwards on one continuous timeline.
  const reference = frames.findIndex(f => time(f) >= -1000)
  assert.ok(
    reference >= 0 && time(frames[reference]) <= -450,
    'no moving reference before input'
  )
  frames = frames.slice(reference)
  const before = frames.filter(f => time(f) < 0)
  assert.ok(
    before.length >= 3 && before.every(f => !f.paused && !f.slow),
    'grid must start playing at ordinary speed'
  )
  // Capture can repeat the same display frame during a stall. The on-device
  // strip and the touch timestamps share a clock; encoded PTS need only be
  // monotonic, and are checked locally around each visible response below.
  for (let i = 1; i < frames.length; i++) {
    assert.ok(
      time(frames[i]) >= time(frames[i - 1]) &&
        frames[i].pts >= frames[i - 1].pts,
      'invalid display clock or frame timestamps'
    )
  }
  let uncertainty = 0
  const held = frames.filter(f => time(f) > 1200 && time(f) < duration - 100)
  assert.ok(
    held.length >= 3 && held.every(f => f.slow && !f.paused),
    'the quarter-speed badge must remain on throughout the hold'
  )
  const responseUpper = (changed: Sample, edge: number): number => {
    const index = frames.indexOf(changed)
    assert.ok(index > 0, 'no frame before the visible response')
    const prev = frames[index - 1]
    // A stale copy of the display-clock strip cannot make a late response
    // look early. Bracket it with the next advancing device timestamp.
    const fresh = frames.slice(index + 1).find(f => time(f) > time(changed))
    assert.ok(fresh != null, 'display clock stopped at visible response')
    const advance =
      time(changed) === time(prev) ? time(fresh) - time(changed) : 0
    const margin = Math.ceil(
      DISPLAY_MS +
        Math.max(advance, time(changed) - time(prev), changed.pts - prev.pts)
    )
    uncertainty = Math.max(uncertainty, margin)
    return Math.ceil(Math.max(0, time(changed) - edge) + margin)
  }
  const visible = (predicate: (f: Sample) => boolean, edge: number): number => {
    const prior = frames.filter(f => time(f) < edge - DISPLAY_MS).at(-1)
    assert.ok(
      prior != null && !predicate(prior),
      'response was already visible before input'
    )
    const changed = frames.find(
      f => time(f) >= edge - DISPLAY_MS && predicate(f)
    )
    assert.ok(changed != null, 'no visible response to input')
    const upper = responseUpper(changed, edge)
    assert.ok(upper <= 250, `visible response upper bound was ${upper} ms`)
    return upper
  }
  const releaseMs = visible(f => !f.slow, duration)
  let gapMs: number | undefined, tapMs: number | undefined
  if (tap != null) {
    assert.ok(
      !contact.up && edges[3].up && close(contact, tap) && close(edges[3], tap),
      'next tap missed the toggle'
    )
    gapMs = elapsed(contact.time, up.time)
    assert.ok(gapMs >= 0 && gapMs <= 250, `gap before tap was ${gapMs} ms`)
    tapMs = visible(f => f.paused, elapsed(contact.time, down.time))
  }
  // Take medians of individual slopes over a long enough span to resolve a
  // quarter-rate 30 fps picture. Every visible camera supplies its own clock.
  const rates = (start: number, end: number): number[] => {
    const observation = frames.filter(f => time(f) >= start && time(f) <= end)
    return first.cameras.map((_, cam) => {
      const valid = observation.filter(f => f.cameras[cam] != null)
      const left = valid.filter(f => time(f) <= start + 300)
      const right = valid.filter(f => time(f) >= end - 300)
      assert.ok(
        left.length >= 3 && right.length >= 3,
        'burned-in camera clock unreadable'
      )
      return median(
        left.flatMap(a =>
          right.map(b => {
            const step = (b.cameras[cam]! - a.cameras[cam]!) | 0
            return step / (time(b) - time(a))
          })
        )
      )
    })
  }
  const heldRates = rates(duration - 1800, duration - 350)
  assert.ok(
    heldRates.length >= 2 &&
      heldRates.every(rate => Math.abs(rate - 0.25) < 0.12),
    `held camera rates ${heldRates.join(', ')}`
  )
  // A pause draws the seek bar across the last tile's clock. Once it fades,
  // both media clocks must still show a stationary picture.
  const afterStart =
    tap == null ? duration + 600 : elapsed(contact.time, down.time) + 2700
  const afterRates = rates(afterStart, afterStart + 1650)
  // A badge can disappear while a native player still crawls. On a plain
  // lift, require each camera's actual pictures to have advanced faster than
  // a quarter-rate camera could within the response budget. One 24 fps media
  // frame accounts for the phase of the last frame before the lift.
  const resumedMs =
    tap == null
      ? first.cameras.map((_, camera) => {
          const prior = frames
            .filter(f => time(f) <= duration && f.cameras[camera] != null)
            .at(-1)
          assert.ok(
            prior != null && duration - time(prior) < 100,
            'no camera clock at the lift'
          )
          const changed = frames.find(f => {
            const delta = time(f) - duration
            if (
              delta < 0 ||
              delta + DISPLAY_MS > 250 ||
              f.cameras[camera] == null
            )
              return false
            const advance = (f.cameras[camera] - prior.cameras[camera]!) | 0
            return advance > (time(f) - time(prior)) * 0.25 + 1000 / 24
          })
          assert.ok(
            changed != null,
            `camera ${camera + 1} did not visibly resume within 250 ms`
          )
          const upper = responseUpper(changed, duration)
          assert.ok(
            upper <= 250,
            `camera ${camera + 1} resume upper bound was ${upper} ms`
          )
          return upper
        })
      : undefined
  const expected = tap == null ? 1 : 0
  assert.ok(
    afterRates.every(rate => Math.abs(rate - expected) < 0.18),
    `post-release camera rates ${afterRates.join(', ')}`
  )
  return {
    duration,
    releaseMs,
    gapMs,
    tapMs,
    uncertainty,
    resumedMs,
    heldRates,
    afterRates
  }
}
