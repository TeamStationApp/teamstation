import { expect } from 'chai'
import { describe, it } from 'mocha'

import { exitReturnAt } from '../../common/scoreboard'
import { liveBoardClock } from './boardClock'

describe('Scoreboard live exit velocity clock', function () {
  const reading = { mph: 55, startedAt: 1000, receivedAt: 1000 }
  const wait = async (ms: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
  it('wakes for an upcoming entry, then cancels its frame when the page closes', async function () {
    const clock = liveBoardClock(900, reading)
    let ticks = 0
    const cancel = clock.subscribe(() => {
      ticks++
    })
    expect(ticks).equals(1)
    await wait(170)
    cancel()
    const atClose = ticks
    expect(atClose).greaterThan(1)
    await wait(60)
    expect(ticks).equals(atClose)
  })
  it('sleeps through the hold, draws the return and stops sampling after expiry', async function () {
    const returns = exitReturnAt(reading)
    const clock = liveBoardClock(returns - 100, reading)
    const times: number[] = []
    const cancel = clock.subscribe(() => {
      times.push(clock.now()!)
    })
    try {
      await wait(650)
      expect(times).to.have.length.greaterThan(2)
      expect(times[1]).at.least(returns - 2)
      expect(times[times.length - 1]).at.least(returns + 500)
      const expired = times.length
      await wait(50)
      expect(times.length).equals(expired)
    } finally {
      cancel()
    }
  })
})
