import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type TransportSnapshot, TvTransport } from './transportState'

// The fixture exposes its collected observations and controllable clock.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  let now = 0
  let position: number | null = 100000
  let extent: { start: number; end: number } | null = { start: 0, end: 1000000 }
  let width = 1000
  let snapshot: TransportSnapshot = { visible: false, rate: 1 }
  const timers = new Map<number, { at: number; callback: () => void }>()
  let id = 0
  const moves: number[] = []
  const seeks: number[] = []
  const pan: boolean[] = []
  const transport = new TvTransport({
    move: seconds => {
      moves.push(seconds)
      position = (position ?? 0) + seconds * 1000
    },
    seek: wall => {
      seeks.push(wall)
      position = wall
    },
    position: () => position,
    extent: () => extent,
    width: () => width,
    panEnabled: value => pan.push(value),
    changed: value => {
      snapshot = value
    },
    now: () => now,
    later: (callback, ms) => {
      const key = ++id
      timers.set(key, { at: now + ms, callback })
      return key
    },
    clear: key => {
      timers.delete(key as number)
    }
  })
  const advance = (ms: number): void => {
    const end = now + ms
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (next === undefined || next[1].at > end) break
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
    }
    now = end
  }
  return {
    transport,
    advance,
    moves,
    seeks,
    pan,
    timers,
    state: () => snapshot,
    bounds: (v: typeof extent) => {
      extent = v
    },
    position: (v: number | null) => {
      position = v
    },
    width: (v: number) => {
      width = v
    }
  }
}

describe('TV transport ownership', () => {
  it('seeks once per click and owns pan for exactly the scrub visibility window', () => {
    const f = fixture()
    expect(f.transport.handle({ kind: 'swipe', direction: 'right' })).equals(
      false
    )
    expect(f.transport.handle({ kind: 'click', direction: 'up' })).equals(false)
    expect(f.transport.handle({ kind: 'playPause' })).equals(false)
    f.transport.handle({ kind: 'click', direction: 'right' })
    f.transport.handle({ kind: 'click', direction: 'left' })
    expect(f.moves).deep.equals([10, -10])
    expect(f.pan).deep.equals([true])
    expect(f.transport.handle({ kind: 'swipe', direction: 'left' })).equals(
      true
    )
    f.advance(1999)
    expect(f.state().visible).equals(true)
    f.advance(1)
    expect(f.state().visible).equals(false)
    expect(f.pan).deep.equals([true, false])
  })

  it('repeats held direction once per third second and suppresses its release click', () => {
    const f = fixture()
    f.transport.handle({ kind: 'hold', direction: 'right', phase: 'begin' })
    f.transport.handle({ kind: 'hold', direction: 'right', phase: 'begin' })
    f.advance(3001)
    expect(f.moves).length(10)
    f.transport.handle({ kind: 'hold', direction: 'right', phase: 'end' })
    f.transport.handle({ kind: 'click', direction: 'right' })
    f.advance(1000)
    expect(f.moves).length(10)
    f.transport.handle({ kind: 'click', direction: 'right' })
    expect(f.moves).length(11)
    f.transport.handle({ kind: 'hold', direction: 'left', phase: 'begin' })
    f.advance(334)
    expect(f.moves.slice(-2)).deep.equals([-10, -10])
    f.transport.handle({ kind: 'hold', direction: 'right', phase: 'end' })
    f.transport.handle({ kind: 'click', direction: 'left' })
    expect(f.moves.slice(-2)).deep.equals([-10, -10])
    f.transport.cancel()
    f.advance(10000)
    expect(f.timers.size).equals(0)
    expect(f.state()).deep.equals({ visible: false, rate: 1 })
  })

  it('ignores touch motion during a hold and accepts a fresh scrub after release', () => {
    const f = fixture()
    f.transport.handle({ kind: 'click', direction: 'right' })
    f.transport.handle({ kind: 'pan', phase: 'begin', x: 0 })
    f.transport.handle({ kind: 'pan', phase: 'change', x: 100 })
    f.transport.handle({ kind: 'hold', direction: 'right', phase: 'begin' })
    f.transport.handle({ kind: 'pan', phase: 'begin', x: 0 })
    f.advance(334)
    f.transport.handle({ kind: 'pan', phase: 'change', x: 1 })
    f.transport.handle({ kind: 'pan', phase: 'end', x: 1 })
    f.advance(3000)
    expect(f.seeks).deep.equals([])
    expect(f.state().visible).equals(true)
    const count = f.moves.length
    f.transport.handle({ kind: 'hold', direction: 'right', phase: 'end' })
    f.transport.handle({ kind: 'pan', phase: 'change', x: 2 })
    f.advance(16)
    expect(f.seeks).deep.equals([])
    f.transport.handle({ kind: 'pan', phase: 'begin', x: 0 })
    f.transport.handle({ kind: 'pan', phase: 'change', x: 100 })
    f.advance(16)
    expect(f.seeks).length(1)
    expect(f.moves).length(count)
    f.transport.handle({ kind: 'pan', phase: 'end', x: 100 })
    f.advance(2000)
    expect(f.state().visible).equals(false)
  })

  it('slow motion restores rate on release, cancellation and direction changes', () => {
    const f = fixture()
    expect(
      f.transport.handle({ kind: 'hold', direction: 'down', phase: 'begin' })
    ).equals(false)
    f.transport.handle({ kind: 'hold', direction: 'up', phase: 'begin' })
    expect(f.state().rate).equals(0.25)
    f.advance(4000)
    expect(f.moves).length(0)
    f.transport.handle({ kind: 'hold', direction: 'up', phase: 'end' })
    expect(f.state().rate).equals(1)
    f.transport.handle({ kind: 'hold', direction: 'up', phase: 'begin' })
    f.transport.handle({ kind: 'hold', direction: 'left', phase: 'begin' })
    expect(f.state().rate).equals(1)
    f.transport.handle({ kind: 'cancel' })
    expect(f.state().visible).equals(false)
  })

  it('scrubs proportionally, coalesces changes, clamps limits and renews the timeout', () => {
    const f = fixture()
    expect(f.transport.handle({ kind: 'pan', phase: 'begin', x: 0 })).equals(
      false
    )
    f.transport.handle({ kind: 'click', direction: 'right' })
    f.transport.handle({ kind: 'pan', phase: 'begin', x: 0 })
    f.transport.handle({ kind: 'pan', phase: 'change', x: 200 })
    f.transport.handle({ kind: 'pan', phase: 'change', x: 500 })
    f.advance(16)
    expect(f.seeks).deep.equals([260000])
    f.advance(2500)
    expect(f.state().visible).equals(true)
    f.transport.handle({ kind: 'pan', phase: 'change', x: -10000 })
    f.advance(16)
    expect(f.seeks.at(-1)).equals(0)
    f.transport.handle({ kind: 'pan', phase: 'end', x: 10000 })
    f.advance(16)
    expect(f.seeks.at(-1)).equals(1000000)
    f.advance(1984)
    expect(f.state().visible).equals(false)
    f.transport.handle({ kind: 'click', direction: 'left' })
    f.transport.handle({ kind: 'pan', phase: 'begin', x: 0 })
    f.transport.handle({ kind: 'pan', phase: 'cancel', x: 10 })
    f.advance(2000)
    expect(f.pan.at(-1)).equals(false)
  })

  it('leaves unknown live bounds intact and cancels queued seeks on exit', () => {
    const f = fixture()
    f.bounds(null)
    f.transport.handle({ kind: 'click', direction: 'right' })
    expect(f.moves).length(0)
    expect(f.state().visible).equals(true)
    f.transport.handle({ kind: 'pan', phase: 'begin', x: 0 })
    f.transport.handle({ kind: 'pan', phase: 'end', x: 50 })
    f.advance(20)
    expect(f.seeks).length(0)
    f.bounds({ start: 0, end: 5000 })
    f.position(null)
    f.transport.handle({ kind: 'pan', phase: 'begin', x: 0 })
    f.position(0)
    f.width(0)
    f.transport.handle({ kind: 'pan', phase: 'begin', x: 0 })
    f.width(1000)
    f.transport.handle({ kind: 'pan', phase: 'begin', x: 100 })
    f.transport.cancel()
    f.advance(5000)
    expect(f.seeks).length(0)
    expect(f.timers.size).equals(0)
  })
})
