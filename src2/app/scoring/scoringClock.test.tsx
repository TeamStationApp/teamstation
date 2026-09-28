import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { singleCorrection } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { runCorrectionClock, type ScoringClock } from './scoringClock'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { CORRECTION_WINDOW_MS, type ScoringState } from './scoringTypes'
import { useScoringClock } from './useScoringClock'
import { useScoringClock as nativeClock } from './useScoringClock.native'
class FakeClock implements ScoringClock {
  time = 0
  sequence = 0
  timers = new Map<number, { due: number; callback: () => void }>()
  now = (): number => this.time
  schedule = (callback: () => void, delay: number): number => {
    const id = ++this.sequence
    this.timers.set(id, { due: this.time + delay, callback })
    return id
  }

  cancel = (id: unknown): void => {
    this.timers.delete(id as number)
  }

  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0]
      if (next == null) break
      this.time = next[1].due
      this.timers.delete(next[0])
      next[1].callback()
    }
    this.time = end
  }
}
let root: Root | undefined
let result: ScoringState
function Window({
  initial,
  paused,
  clock
}: {
  initial: ScoringState
  paused: boolean
  clock: ScoringClock
}): React.ReactElement {
  const [state, dispatch] = useReducer(scoringReducer, initial)
  result = state
  useScoringClock(state, paused, dispatch, clock)
  return <div>{state.phase}</div>
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  delete (document as unknown as { hidden?: boolean }).hidden
})
describe('correction clock', function () {
  it('uses elapsed monotonic time and makes canceled callbacks inert', function () {
    const clock = new FakeClock()
    let elapsed = 0
    const stop = runCorrectionClock(clock, duration => {
      elapsed += duration
    })
    const stale = [...clock.timers.values()][0].callback
    clock.advance(250)
    expect(elapsed).equals(250)
    stop()
    clock.advance(20000)
    stale()
    expect(elapsed).equals(250)
    nativeClock()
  })
  it('pauses for a sheet and a hidden document, then closes exactly once at the remaining deadline', async function () {
    let initial = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
    initial = singleCorrection(initial)
    const clock = new FakeClock()
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const render = async (paused: boolean): Promise<void> => {
      await act(async () => {
        root!.render(<Window initial={initial} paused={paused} clock={clock} />)
      })
    }
    await render(false)
    await act(async () => {
      clock.advance(2500)
    })
    expect(result.correctionWindow!.remainingMs).equals(
      CORRECTION_WINDOW_MS - 2500
    )
    await render(true)
    await act(async () => {
      clock.advance(50000)
    })
    expect(result.correctionWindow!.remainingMs).equals(
      CORRECTION_WINDOW_MS - 2500
    )
    await render(false)
    await act(async () => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: true
      })
      document.dispatchEvent(new window.Event('visibilitychange'))
    })
    await act(async () => {
      clock.advance(50000)
    })
    expect(result.correctionWindow!.remainingMs).equals(
      CORRECTION_WINDOW_MS - 2500
    )
    await act(async () => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: false
      })
      document.dispatchEvent(new window.Event('visibilitychange'))
    })
    await act(async () => {
      clock.advance(CORRECTION_WINDOW_MS - 2500 - 50)
    })
    expect(result.session.liveData.plays.allPlays).has.length(0)
    await act(async () => {
      clock.advance(50)
    })
    expect(result.session.liveData.plays.allPlays).has.length(1)
    await act(async () => {
      clock.advance(50000)
    })
    expect(result.session.liveData.plays.allPlays).has.length(1)
    expect(result.session.liveData.plays.currentPlay!.matchup.batter.id).equals(
      2
    )
  })
})
