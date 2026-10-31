import { expect } from 'chai'
import { describe, it } from 'mocha'

import { spread } from './spread'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('spread', function () {
  it('runs each item exactly once, at different moments inside the window', async function () {
    const items = Array.from({ length: 200 }, (_, index) => index)
    const ran = new Map<number, number[]>()
    const startedAt = Date.now()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    spread(
      items,
      300,
      item => {
        ran.set(item, [...(ran.get(item) ?? []), Date.now() - startedAt])
      },
      timers
    )
    // Nothing is due at once, and every item waits on its own timer.
    expect(timers.size).equals(200)
    await wait(500)
    expect(timers.size).equals(0)
    expect([...ran.keys()].sort((a, b) => a - b)).deep.equals(items)
    const offsets = [...ran.values()].map(times => {
      expect(times).to.have.length(1)
      return times[0]
    })
    // The timer's slack, not the window, is why the top is above 300.
    expect(Math.max(...offsets)).below(450)
    expect(Math.max(...offsets)).above(150)
    expect(Math.min(...offsets)).below(150)
  })

  it('acts at once for 0, before it returns', function () {
    const ran: string[] = []
    const timers = new Set<ReturnType<typeof setTimeout>>()
    spread(['a', 'b'], 0, item => ran.push(item), timers)
    expect(ran).deep.equals(['a', 'b'])
    expect(timers.size).equals(0)
  })

  it('leaves alone an item that arrives after it began', async function () {
    const live = new Set(['here'])
    const ran: string[] = []
    spread(live, 20, item => ran.push(item))
    live.add('later')
    await wait(80)
    expect(ran).deep.equals(['here'])
  })

  it('goes on past an act that throws', async function () {
    const failing = console.error
    const lines: unknown[] = []
    console.error = (line: unknown) => lines.push(line)
    try {
      for (const window of [0, 20]) {
        const ran: string[] = []
        spread(['bad', 'good'], window, item => {
          if (item === 'bad') throw new Error('gone')
          ran.push(item)
        })
        await wait(window * 3)
        expect(ran).deep.equals(['good'])
      }
    } finally {
      console.error = failing
    }
    expect(lines).deep.equals(['resync: Error: gone', 'resync: Error: gone'])
  })

  it('runs nothing whose timer its owner cleared', async function () {
    const ran: string[] = []
    const timers = new Set<ReturnType<typeof setTimeout>>()
    spread(['a', 'b', 'c'], 20, item => ran.push(item), timers)
    for (const timer of timers) clearTimeout(timer)
    await wait(60)
    expect(ran).deep.equals([])
  })
})
