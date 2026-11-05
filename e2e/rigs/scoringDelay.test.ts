import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { scoringDelay } from './scoringDelay'

describe('concurrent scoring interleaving', () => {
  it('replays the same schedule and varies distinct seeds within the bounded delay', () => {
    const schedule = (seed: number): number[] => {
      const next = scoringDelay(seed)
      return Array.from({ length: 150 }, next)
    }
    const first = schedule(20261104)
    assert.deepEqual(first, schedule(20261104))
    assert.notDeepEqual(first, schedule(20261105))
    assert(first.every(value => value >= 0 && value <= 250))
    assert(new Set(first).size > 50)
    assert.equal(schedule(0).length, 150)
    assert.equal(schedule(0xffffffff).length, 150)
  })
  it('rejects invalid seeds instead of silently running a different schedule', () => {
    for (const value of [NaN, Infinity, -1, 1.5, 0x100000000])
      assert.throws(() => scoringDelay(value), /unsigned 32-bit integer/)
  })
})
