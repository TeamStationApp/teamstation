import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { composerTrackingGaps } from './composerMotion'

function samples(
  rows: Array<number | null>,
  fps = 60
): Array<{ row: number | null; seconds: number }> {
  return rows.map((row, frame) => ({ row, seconds: frame / fps }))
}

describe('composer motion in recorded frames', function () {
  it('identifies the first opening even when later frames show both directions', function () {
    const positions = samples([
      149,
      null,
      null,
      null,
      null,
      null,
      null,
      12,
      8,
      5,
      2,
      0,
      25,
      50,
      75,
      100,
      125,
      149
    ])
    assert.deepEqual(composerTrackingGaps(positions, 149), [
      {
        fromFrame: 0,
        toFrame: 7,
        missingFrames: 6,
        elapsedSeconds: 7 / 60,
        distance: 137
      }
    ])
  })

  it('detects the control disappearing during the return as well as the opening', function () {
    for (const rows of [
      [0, null, 28],
      [28, null, 0]
    ]) {
      const [gap] = composerTrackingGaps(samples(rows), 100)
      assert.equal(gap.missingFrames, 1)
      assert.equal(gap.distance, 28)
    }
  })

  it('accepts a continuously tracked reversal and brief stationary tracking noise', function () {
    const positions = samples([0, null, 1, 10, 20, 30, 20, 10, 0])
    assert.deepEqual(composerTrackingGaps(positions, 30), [])
  })

  it('rejects a large single step even when both endpoints are visible', function () {
    const [gap] = composerTrackingGaps(samples([30, 29, 28, 5, 0]), 30)
    assert.equal(gap.fromFrame, 2)
    assert.equal(gap.missingFrames, 0)
  })

  it('rejects a prolonged loss even if the control returns to the same row', function () {
    const [gap] = composerTrackingGaps(samples([5, null, null, 5], 10), 30)
    assert.equal(gap.distance, 0)
    assert.equal(gap.elapsedSeconds, 0.3)
  })
})
