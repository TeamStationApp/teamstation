import { expect } from 'chai'
import { describe, it } from 'mocha'

import { frameThrottle } from './frameThrottle'

function frames(): {
  schedule: (run: () => void) => number
  unschedule: (handle: number) => void
  tick: () => void
} {
  const queue = new Map<number, () => void>()
  let next = 1
  return {
    schedule: run => {
      queue.set(next, run)
      return next++
    },
    unschedule: handle => {
      queue.delete(handle)
    },
    tick: () => {
      const runs = [...queue.values()]
      queue.clear()
      for (const run of runs) run()
    }
  }
}

describe('the frame throttle', function () {
  it('delivers only the latest value once a frame', function () {
    const seen: number[] = []
    const clock = frames()
    const send = frameThrottle<number>(
      value => seen.push(value),
      clock.schedule,
      clock.unschedule
    )
    send(1)
    send(2)
    send(3)
    expect(seen).deep.equals([])
    clock.tick()
    expect(seen).deep.equals([3])
    clock.tick()
    expect(seen).deep.equals([3])
    send(4)
    clock.tick()
    expect(seen).deep.equals([3, 4])
  })
  it('flushes a pending value at once, and cancels one', function () {
    const seen: number[] = []
    const clock = frames()
    const send = frameThrottle<number>(
      value => seen.push(value),
      clock.schedule,
      clock.unschedule
    )
    send(5)
    send.flush()
    expect(seen).deep.equals([5])
    clock.tick()
    expect(seen).deep.equals([5])
    send(6)
    send.cancel()
    clock.tick()
    send.flush()
    expect(seen).deep.equals([5])
  })
  it('waits for a frame by default, with or without requestAnimationFrame', async function () {
    const frame = globalThis.requestAnimationFrame
    const cancel = globalThis.cancelAnimationFrame
    try {
      for (const key of ['requestAnimationFrame', 'cancelAnimationFrame'])
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value: undefined
        })
      const seen: number[] = []
      const send = frameThrottle<number>(value => seen.push(value))
      send(1)
      expect(seen).deep.equals([])
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(seen).deep.equals([1])
      send(2)
      send.cancel()
    } finally {
      Object.defineProperty(globalThis, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: frame
      })
      Object.defineProperty(globalThis, 'cancelAnimationFrame', {
        configurable: true,
        writable: true,
        value: cancel
      })
    }
  })
  it('uses the animation frame by default', async function () {
    if (typeof requestAnimationFrame !== 'function') this.skip()
    const seen: number[] = []
    const send = frameThrottle<number>(value => seen.push(value))
    send(7)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(seen).deep.equals([7])
    send(8)
    send.cancel()
  })
})
