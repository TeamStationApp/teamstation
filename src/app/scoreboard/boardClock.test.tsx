import { mock } from 'node:test'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { exitReturnAt } from '../../common/scoreboard'
import { type FrameClock, installFrameClock } from '../../test/frameClock'
import { liveBoardClock } from './boardClock'

describe('Scoreboard live exit velocity clock', function () {
  const reading = { mph: 55, startedAt: 1000, receivedAt: 1000 }
  let frames: FrameClock
  beforeEach(function () {
    frames = installFrameClock()
    mock.timers.enable({ apis: ['setTimeout'] })
  })
  afterEach(function () {
    mock.timers.reset()
    frames.restore()
  })
  it('wakes for an upcoming entry, then cancels its frame when the page closes', function () {
    const clock = liveBoardClock(900, reading)
    let ticks = 0
    const cancel = clock.subscribe(() => {
      ticks++
    })
    expect(ticks).equals(1)
    frames.advance(100)
    mock.timers.tick(100)
    frames.advance(64)
    cancel()
    const atClose = ticks
    expect(atClose).greaterThan(1)
    frames.advance(500)
    expect(ticks).equals(atClose)
  })
  it('sleeps through the hold, draws the return and stops sampling after expiry', function () {
    const returns = exitReturnAt(reading)
    const clock = liveBoardClock(returns - 96, reading)
    const times: number[] = []
    const cancel = clock.subscribe(() => {
      times.push(clock.now()!)
    })
    frames.advance(96)
    expect(times.length).equals(1)
    mock.timers.tick(96)
    expect(times[1]).equals(returns)
    frames.advance(512)
    expect(times[times.length - 1]).at.least(returns + 500)
    const expired = times.length
    frames.advance(512)
    expect(times.length).equals(expired)
    cancel()
  })
})
