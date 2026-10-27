import { expect } from 'chai'
import { describe, it } from 'mocha'

import { SCRUB_SEEK_MS, type ScrubClock, scrubSeeks } from './scrubSeeks'

/** A clock the test moves by hand, with the timers it would have fired. */
function fakeClock(): ScrubClock & { advance: (ms: number) => void } {
  let at = 1000
  let timers: Array<{ due: number; run: () => void; id: number }> = []
  let next = 1
  return {
    now: () => at,
    set: (run, ms) => {
      const id = next++
      timers.push({ due: at + ms, run, id })
      return id
    },
    clear: id => {
      timers = timers.filter(timer => timer.id !== id)
    },
    advance: ms => {
      at += ms
      const due = timers.filter(timer => timer.due <= at)
      timers = timers.filter(timer => timer.due > at)
      for (const timer of due) timer.run()
    }
  }
}

describe('scrub seeks', function () {
  it('seeks the first move at once, then at most every interval, to the newest place', function () {
    const clock = fakeClock()
    const sought: number[] = []
    const seeks = scrubSeeks(at => sought.push(at), 250, clock)
    seeks.move(10)
    expect(sought).deep.equals([10])
    // Sixty moves in the next second: four seeks, each to the newest.
    for (let step = 1; step <= 60; step++) {
      clock.advance(1000 / 60)
      seeks.move(10 + step)
    }
    expect(sought.length).within(4, 5)
    expect(sought[1]).greaterThan(20)
    clock.advance(250)
    expect(sought[sought.length - 1]).equals(70)
  })

  it('always seeks where the finger lifts, and drops the seek still waiting', function () {
    const clock = fakeClock()
    const sought: number[] = []
    const seeks = scrubSeeks(at => sought.push(at), 250, clock)
    seeks.move(100)
    clock.advance(50)
    seeks.move(200)
    seeks.end(300)
    expect(sought).deep.equals([100, 300])
    clock.advance(1000)
    expect(sought).deep.equals([100, 300])
  })

  it('seeks a tap, which is only an end, at once', function () {
    const clock = fakeClock()
    const sought: number[] = []
    scrubSeeks(at => sought.push(at), 250, clock).end(42)
    expect(sought).deep.equals([42])
  })

  it('cancels a waiting seek when the view goes', function () {
    const clock = fakeClock()
    const sought: number[] = []
    const seeks = scrubSeeks(at => sought.push(at), 250, clock)
    seeks.move(1)
    seeks.move(2)
    seeks.cancel()
    clock.advance(1000)
    expect(sought).deep.equals([1])
  })

  it('runs on the real clock with the default interval', async function () {
    const sought: number[] = []
    const seeks = scrubSeeks(at => sought.push(at))
    seeks.move(1)
    seeks.move(2)
    expect(sought).deep.equals([1])
    await new Promise(resolve => setTimeout(resolve, SCRUB_SEEK_MS + 50))
    expect(sought).deep.equals([1, 2])
    seeks.cancel()
  })
})
