'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { MemoryPeakGuard, LOOKBACK_WINDOWS } = require('./memoryPeakGuard')

const WINDOW = 4 * 60 * 1000
const HOUR = 60 * 60 * 1000

// Samples at 0, W, 2W, … nW. That closes `n` four-minute windows.
function closeWindows(guard, count, value, t0 = 0) {
  let last = null
  for (let i = 0; i <= count; i += 1) {
    last = guard.sample(t0 + i * WINDOW, value)
  }
  return { t: t0 + count * WINDOW, last }
}

describe('MemoryPeakGuard', () => {
  it('ignores a single 4-minute window whose floor is 30% higher', () => {
    const guard = new MemoryPeakGuard()
    const { t } = closeWindows(guard, LOOKBACK_WINDOWS, 200)
    assert.equal(guard.sample(t + WINDOW, 280), null)
    assert.equal(guard.sample(t + WINDOW * 2, 280), null)
  })

  it('aborts when two consecutive 4-minute floors are 30% above the hour-ago floor', () => {
    const guard = new MemoryPeakGuard()
    const { t } = closeWindows(guard, LOOKBACK_WINDOWS, 200)
    assert.equal(guard.sample(t + WINDOW, 280), null)
    assert.equal(guard.sample(t + WINDOW * 2, 280), null)
    const reason = guard.sample(t + WINDOW * 3, 280)
    assert.match(reason, /memory leak/)
    assert.match(reason, /floor 280MB/)
    assert.match(reason, /200MB/)
  })

  it('does not abort a 29% floor rise', () => {
    const guard = new MemoryPeakGuard()
    const { t } = closeWindows(guard, LOOKBACK_WINDOWS, 200)
    assert.equal(guard.sample(t + WINDOW, 258), null)
    assert.equal(guard.sample(t + WINDOW * 2, 258), null)
  })

  it('ignores a replay spike when the window floor stays at the live baseline', () => {
    const guard = new MemoryPeakGuard({ lookbackWindows: 1, streakNeeded: 1 })
    assert.equal(guard.sample(0, 215), null)
    assert.equal(guard.sample(60 * 1000, 329), null)
    assert.equal(guard.sample(WINDOW, 215), null)
    assert.equal(guard.sample(WINDOW + 60 * 1000, 220), null)
    assert.equal(guard.sample(WINDOW * 2, 215), null)
  })

  it('treats a brief spike as one window and resets the streak when the next settles', () => {
    const guard = new MemoryPeakGuard()
    const { t } = closeWindows(guard, LOOKBACK_WINDOWS, 200)
    assert.equal(guard.sample(t + WINDOW, 500), null)
    assert.equal(guard.sample(t + WINDOW * 2, 210), null)
    assert.equal(guard.sample(t + WINDOW * 3, 210), null)
  })

  it('tracks the floor inside a window, not the last sample', () => {
    const guard = new MemoryPeakGuard({ lookbackWindows: 1, streakNeeded: 1 })
    assert.equal(guard.sample(0, 200), null)
    assert.equal(guard.sample(60 * 1000, 200), null)
    assert.equal(guard.sample(WINDOW, 280), null)
    assert.equal(guard.sample(WINDOW + 60 * 1000, 400), null)
    const reason = guard.sample(WINDOW * 2, 280)
    assert.match(reason, /floor 280MB/)
    assert.match(reason, /200MB/)
    assert.match(reason, /peak 400MB/)
  })

  it('lookback is one hour of 4-minute windows', () => {
    assert.equal(HOUR / WINDOW, LOOKBACK_WINDOWS)
  })
})
