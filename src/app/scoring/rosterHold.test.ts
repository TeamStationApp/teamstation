import { mock } from 'node:test'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ROSTER_DRAG_DISTANCE, ROSTER_HOLD_MS, RosterHold } from './rosterHold'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
describe('roster half-second hold', function () {
  it('activates at 500ms and remains pending at 499ms', function () {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      let calls = 0
      const hold = new RosterHold(() => {
        calls++
      })
      hold.start({ x: 0, y: 0 })
      mock.timers.tick(499)
      expect(hold.active).equals(false)
      mock.timers.tick(1)
      expect(hold.active).equals(true)
      expect(calls).equals(1)
      hold.cancel()
    } finally {
      mock.timers.reset()
    }
  })
  it('waits 500ms, tolerates jitter and does not turn a held contact into a tap', async function () {
    const activated: unknown[] = []
    const hold = new RosterHold(p => activated.push(p))
    hold.start({ x: 10, y: 20 })
    hold.move({ x: 13, y: 24 })
    expect(hold.active).equals(false)
    await wait(510)
    expect(hold.active).equals(true)
    expect(activated).deep.equals([{ x: 10, y: 20 }])
    hold.move({ x: 100, y: 200 })
    expect(hold.active).equals(true)
    expect(hold.finish()).equals(false)
    expect(hold.active).equals(false)
  })
  it('keeps scrolling and cancellation inert until a fresh contact', async function () {
    let calls = 0
    const hold = new RosterHold(() => {
      calls++
    })
    hold.move({ x: 0, y: 0 })
    hold.start({ x: 0, y: 0 })
    hold.move({ x: 0, y: 7 })
    await wait(510)
    expect(calls).equals(0)
    expect(hold.finish()).equals(false)
    hold.start({ x: 0, y: 0 })
    hold.cancel()
    expect(hold.finish()).equals(false)
    hold.start({ x: 0, y: 0 })
    expect(hold.finish()).equals(true)
    await wait(510)
    expect(calls).equals(0)
  })
})
describe('roster immediate drag (U31)', function () {
  it('starts a drag at 10 px with no timer and takes 9 px for a tap', function () {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const activated: unknown[] = []
      const hold = new RosterHold(
        p => activated.push(p),
        () => true
      )
      hold.start({ x: 0, y: 0 })
      mock.timers.tick(5000)
      expect(hold.active).equals(false)
      hold.move({ x: 9, y: 0 })
      expect(hold.active).equals(false)
      expect(hold.finish()).equals(true)
      expect(activated).deep.equals([])
      hold.start({ x: 0, y: 0 })
      hold.move({ x: 6, y: 8 })
      expect(hold.active).equals(true)
      expect(activated).deep.equals([{ x: 0, y: 0 }])
      hold.move({ x: 100, y: 100 })
      expect(activated).length(1)
      expect(hold.finish()).equals(false)
      expect(hold.active).equals(false)
      hold.move({ x: 50, y: 50 })
      expect(activated).length(1)
    } finally {
      mock.timers.reset()
    }
  })
})
describe('roster card grip (N2)', function () {
  it('picks a card up as a touch lands on its grip, after ROSTER_HOLD_MS on its body, and scrolls for a body move before then', function () {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      expect(ROSTER_HOLD_MS).equals(500)
      const activated: unknown[] = []
      const hold = new RosterHold(p => activated.push(p))
      // The grip: at once, still where the touch landed, and never a tap.
      hold.start({ x: 4, y: 20 }, true)
      expect(hold.active).equals(true)
      expect(activated).deep.equals([{ x: 4, y: 20 }])
      hold.move({ x: 4, y: 200 })
      expect(activated).length(1)
      expect(hold.finish()).equals(false)
      // A grip contact that ends short of ROSTER_DRAG_DISTANCE is a tap,
      // though it lifted the card; one that went that far is not.
      hold.start({ x: 4, y: 20 }, true)
      hold.move({ x: 4 + ROSTER_DRAG_DISTANCE - 1, y: 20 })
      expect(hold.active).equals(true)
      expect(hold.finish()).equals(true)
      hold.start({ x: 4, y: 20 }, true)
      hold.move({ x: 4 + ROSTER_DRAG_DISTANCE, y: 20 })
      hold.move({ x: 4, y: 20 })
      expect(hold.finish()).equals(false)
      // Held still on the grip for ROSTER_HOLD_MS and let go in place, it
      // calls the drag off, as a body hold does: no tap.
      const now = Date.now
      try {
        let clock = 1000
        Date.now = () => clock
        hold.start({ x: 4, y: 20 }, true)
        clock += ROSTER_HOLD_MS - 1
        expect(hold.finish()).equals(true)
        hold.start({ x: 4, y: 20 }, true)
        clock += ROSTER_HOLD_MS
        expect(hold.finish()).equals(false)
      } finally {
        Date.now = now
      }
      activated.splice(1)
      // The body: nothing until the hold has run its whole time.
      hold.start({ x: 90, y: 20 })
      mock.timers.tick(ROSTER_HOLD_MS - 1)
      expect(hold.active).equals(false)
      mock.timers.tick(1)
      expect(hold.active).equals(true)
      expect(activated).deep.equals([
        { x: 4, y: 20 },
        { x: 90, y: 20 }
      ])
      hold.cancel()
      // A body move before the hold fires is a scroll: no drag follows.
      hold.start({ x: 90, y: 20 })
      mock.timers.tick(100)
      hold.move({ x: 90, y: 60 })
      mock.timers.tick(ROSTER_HOLD_MS)
      expect(hold.active).equals(false)
      expect(activated).length(2)
      expect(hold.finish()).equals(false)
      // A grip start drags even where a card's body would wait for distance.
      const immediate = new RosterHold(
        p => activated.push(p),
        () => true
      )
      immediate.start({ x: 2, y: 2 }, true)
      expect(immediate.active).equals(true)
      expect(activated).length(3)
      immediate.cancel()
    } finally {
      mock.timers.reset()
    }
  })
})
