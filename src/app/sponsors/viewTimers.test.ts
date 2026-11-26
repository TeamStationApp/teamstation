import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ROW_VIEW_MS, viewTimers } from './viewTimers'

/** A clock the test moves by hand, for the timers `viewTimers` sets. */
function clock(): {
  setTimer: (run: () => void, wait: number) => unknown
  clearTimer: (handle: unknown) => void
  advance: (ms: number) => void
  pending: () => number
} {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    setTimer: (run, wait) => {
      const handle = next++
      timers.set(handle, { at: now + wait, run })
      return handle
    },
    clearTimer: handle => {
      timers.delete(handle as number)
    },
    advance: ms => {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (due == null) break
        timers.delete(due[0])
        now = due[1].at
        due[1].run()
      }
      now = until
    },
    pending: () => timers.size
  }
}

describe('viewTimers', () => {
  it('sees a key that stays 5 s on screen, once', () => {
    const time = clock()
    const seen: string[] = []
    const timers = viewTimers(key => seen.push(key), time)
    timers.update(['sponsored:ser_a'])
    time.advance(ROW_VIEW_MS - 1)
    expect(seen).deep.equals([])
    time.advance(1)
    expect(seen).deep.equals(['sponsored:ser_a'])
    // Still on screen: the same stay is not seen again.
    timers.update(['sponsored:ser_a'])
    time.advance(ROW_VIEW_MS * 3)
    expect(seen).deep.equals(['sponsored:ser_a'])
  })
  it('cancels a key that leaves at 4 s, and times its return afresh', () => {
    const time = clock()
    const seen: string[] = []
    const timers = viewTimers(key => seen.push(key), time)
    timers.update(['sponsored:ser_a'])
    time.advance(4000)
    timers.update([])
    expect(time.pending()).equals(0)
    time.advance(ROW_VIEW_MS)
    expect(seen).deep.equals([])
    timers.update(['sponsored:ser_a'])
    time.advance(4999)
    expect(seen).deep.equals([])
    time.advance(1)
    expect(seen).deep.equals(['sponsored:ser_a'])
    // Leaving after it was seen and coming back is another view.
    timers.update([])
    timers.update(['sponsored:ser_a'])
    time.advance(ROW_VIEW_MS)
    expect(seen).deep.equals(['sponsored:ser_a', 'sponsored:ser_a'])
  })
  it('times two keys separately', () => {
    const time = clock()
    const seen: string[] = []
    const timers = viewTimers(key => seen.push(key), time)
    timers.update(['sponsored:ser_a'])
    time.advance(2000)
    timers.update(['sponsored:ser_a', 'sponsored:ser_b'])
    time.advance(3000)
    expect(seen).deep.equals(['sponsored:ser_a'])
    timers.update(['sponsored:ser_b'])
    time.advance(2000)
    expect(seen).deep.equals(['sponsored:ser_a', 'sponsored:ser_b'])
  })
  it('stops every timer', () => {
    const time = clock()
    const seen: string[] = []
    const timers = viewTimers(key => seen.push(key), time)
    timers.update(['sponsored:ser_a', 'sponsored:ser_b'])
    time.advance(ROW_VIEW_MS)
    timers.update(['sponsored:ser_a', 'sponsored:ser_b', 'sponsored:ser_c'])
    timers.stop()
    expect(time.pending()).equals(0)
    time.advance(ROW_VIEW_MS)
    expect(seen).deep.equals(['sponsored:ser_a', 'sponsored:ser_b'])
  })
  it('runs on the real timers by default', async () => {
    const seen: string[] = []
    const timers = viewTimers(key => seen.push(key), { ms: 5 })
    timers.update(['k1', 'k2'])
    timers.update(['k1'])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(seen).deep.equals(['k1'])
    timers.update(['k3'])
    timers.stop()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(seen).deep.equals(['k1'])
  })
})
