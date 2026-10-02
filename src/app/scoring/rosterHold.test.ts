import { mock } from 'node:test'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { RosterHold } from './rosterHold'

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
