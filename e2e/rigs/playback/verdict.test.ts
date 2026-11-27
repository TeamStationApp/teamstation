import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { judgeCounter } from './counter'
import type { MotionVerdict } from './motion'
import { judgeReadout, parseReadout } from './readout'
import { judgeStep, type TileEvidence } from './verdict'

function motion(startMs: number | null, freezeMs = 0): MotionVerdict {
  return {
    startMs,
    freezes: freezeMs > 0 ? [{ fromMs: 1000, toMs: 1000 + freezeMs }] : [],
    longestFreezeMs: freezeMs
  }
}

function tiles(...verdicts: MotionVerdict[]): TileEvidence[] {
  return verdicts.map((verdict, index) => ({
    tile: `angle ${index + 1}`,
    motion: verdict
  }))
}

const frozenReadout = judgeReadout(
  [100, 100, 100, 100, 100, 100, 100, 100].map((atSec, index) =>
    parseReadout(
      [`1st  buf 0.0s  ready 2  at ${atSec}  to ${atSec}  paused  ok`],
      index * 500
    )
  )
)

describe('playback probe: step verdict', function () {
  it('passes a 3.9 s start and fails a 4.1 s one, reporting the slowest tile', function () {
    const quick = judgeStep({
      step: 'Watch',
      content: 'tp',
      tiles: tiles(motion(1200), motion(3900))
    })
    assert.equal(quick.pass, true)
    assert.equal(quick.startMs, 3900)
    const late = judgeStep({
      step: 'Watch',
      content: 'tp',
      tiles: tiles(motion(4100))
    })
    assert.equal(late.pass, false)
    assert.deepEqual(late.reasons, ['angle 1 started after 4100 ms'])
  })

  it('fails a tile that dropped more than one frame in twenty, as a Pixel 10 grid of three did', function () {
    const verdict = judgeStep({
      step: '3: scrub 5',
      content: 'tp',
      tiles: tiles(motion(900)),
      frames: [
        { tile: 'Home', dropped: 120, total: 600 },
        { tile: 'Primary', dropped: 3, total: 600 },
        { tile: '3rd', dropped: 0, total: 0 }
      ]
    })
    assert.deepEqual(verdict.reasons, [
      'Home dropped 20 % of its frames (120 of 600)'
    ])
  })

  it('fails a picture that shows another angle than the one chosen, and notes one it could not read', function () {
    const wrong = judgeStep({
      step: '2: Watch',
      content: 'tp',
      tiles: [
        {
          tile: 'Primary',
          motion: motion(500),
          angle: { want: 'Primary', seen: [null, 'Home', 'Home'] }
        }
      ]
    })
    assert.deepEqual(wrong.reasons, ['Primary showed Home, not Primary'])
    const right = judgeStep({
      step: '2: angle Home',
      content: 'tp',
      tiles: [
        {
          tile: 'Home',
          motion: motion(500),
          angle: { want: 'Home', seen: ['Primary', 'Home', null] }
        }
      ]
    })
    assert.equal(right.pass, true)
    const unread = judgeStep({
      step: '2: angle 1st',
      content: 'tp',
      tiles: [
        {
          tile: '1st',
          motion: motion(500),
          angle: { want: '1st', seen: [null, null, null] }
        }
      ]
    })
    assert.equal(unread.pass, true)
    assert.deepEqual(unread.notes, [
      "1st: the picture's name could not be read"
    ])
  })

  it('fails a tile that never started', function () {
    const verdict = judgeStep({
      step: 'scrub 3',
      content: 'real',
      tiles: tiles(motion(800), motion(null))
    })
    assert.equal(verdict.startMs, null)
    assert.deepEqual(verdict.reasons, ['angle 2 never started moving'])
  })

  it('fails a screenshot freeze on the test pattern by itself', function () {
    const verdict = judgeStep({
      step: 'play',
      content: 'tp+',
      tiles: tiles(motion(500, 800))
    })
    assert.deepEqual(verdict.reasons, [
      'angle 1 picture stood still for 800 ms'
    ])
  })

  it('only notes an uncorroborated screenshot freeze on real footage', function () {
    const verdict = judgeStep({
      step: 'play',
      content: 'real',
      tiles: tiles(motion(500, 800))
    })
    assert.equal(verdict.pass, true)
    assert.match(verdict.notes.join(), /uncorroborated on real footage/)
  })

  it('fails a real-footage freeze the readout or the webcam saw too', function () {
    const byReadout = judgeStep({
      step: 'play',
      content: 'real',
      tiles: tiles(motion(500, 800)),
      readout: frozenReadout
    })
    assert.equal(byReadout.pass, false)
    assert.ok(
      byReadout.reasons.some(reason =>
        reason.startsWith('readout: 1st stood still')
      )
    )
    const byWebcam = judgeStep({
      step: 'play',
      content: 'real',
      tiles: tiles(motion(500, 800)),
      webcam: motion(400, 900)
    })
    assert.deepEqual(byWebcam.reasons, [
      'angle 1 picture stood still for 800 ms',
      'webcam: screen stood still for 900 ms'
    ])
  })

  it('fails on the counter, and notes when the webcam and screenshots disagree', function () {
    const counter = judgeCounter(
      [0, 30, 30, 60, 90].map((frame, index) => ({ atMs: index * 500, frame }))
    )
    const verdict = judgeStep({
      step: 'play',
      content: 'tp',
      tiles: [{ tile: 'Home', motion: motion(300), counter }],
      webcam: motion(300)
    })
    assert.equal(verdict.pass, false)
    assert.match(verdict.reasons.join(), /Home counter stood still at frame 30/)
    const disagree = judgeStep({
      step: 'play',
      content: 'tp',
      tiles: tiles(motion(300)),
      webcam: motion(300, 700)
    })
    assert.deepEqual(disagree.notes, [
      'webcam and screenshots disagree about a freeze'
    ])
  })

  it('starts when the player says it plays, if that is later than the pictures', function () {
    const later = judgeStep({
      step: 'full screen',
      content: 'tp',
      tiles: tiles(motion(1059)),
      readoutStartMs: 3600
    })
    assert.equal(later.startMs, 3600)
    assert.equal(later.pass, true)
    const late = judgeStep({
      step: 'full screen',
      content: 'tp',
      tiles: tiles(motion(1059)),
      readoutStartMs: 4700
    })
    assert.deepEqual(late.reasons, [
      'the player said it was playing only after 4700 ms'
    ])
    const never = judgeStep({
      step: 'full screen',
      content: 'tp',
      tiles: tiles(motion(1059)),
      readoutStartMs: null
    })
    assert.equal(never.startMs, null)
    assert.deepEqual(never.reasons, ['the player never said it was playing'])
    const earlier = judgeStep({
      step: 'x',
      content: 'tp',
      tiles: tiles(motion(2000)),
      readoutStartMs: 500
    })
    assert.equal(earlier.startMs, 2000)
  })

  it('fails a scrub that did not land where it was dragged', function () {
    const landed = judgeStep({
      step: 'scrub',
      content: 'real',
      tiles: tiles(motion(900)),
      landing: { wantSec: 1407, gotSec: 1406.3, toleranceSec: 60 }
    })
    assert.equal(landed.pass, true)
    const stayed = judgeStep({
      step: 'scrub',
      content: 'real',
      tiles: tiles(motion(900)),
      landing: { wantSec: 1407, gotSec: 74.2, toleranceSec: 60 }
    })
    assert.deepEqual(stayed.reasons, ['landed at 74 s, not near 1407 s'])
    const unknown = judgeStep({
      step: 'scrub',
      content: 'real',
      tiles: tiles(motion(900)),
      landing: { wantSec: 1407, gotSec: null, toleranceSec: 60 }
    })
    assert.deepEqual(unknown.reasons, [
      'no readout to say where the scrub landed'
    ])
  })
})
