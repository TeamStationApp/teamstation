import { expect } from 'chai'
import { describe, it } from 'mocha'

import { recordPitch } from './pitchControls'
import { DEMO_SCOREBOARD } from './scoreboardModel'

describe('local pitch controls', function () {
  it('counts pitches without allowing a foul to become strike three', function () {
    const state = { ...DEMO_SCOREBOARD, strikes: 2 }
    const foul = recordPitch(state, 'foul')
    expect(foul.strikes).equals(2)
    expect(foul.pitchCount).equals(state.pitchCount + 1)
    expect(state.pitchCount).equals(DEMO_SCOREBOARD.pitchCount)
    for (const kind of ['called', 'swing'] as const) {
      const strikeout = recordPitch(state, kind)
      expect(strikeout.strikes).equals(0)
      expect(strikeout.balls).equals(0)
      expect(strikeout.outs).equals(state.outs + 1)
    }
  })
  it('resets a walk count and leaves batted-ball outcomes to the scorer', function () {
    const walk = recordPitch({ ...DEMO_SCOREBOARD, balls: 3 }, 'ball')
    expect(walk.balls).equals(0)
    expect(walk.strikes).equals(0)
    expect(walk.outs).equals(DEMO_SCOREBOARD.outs)
    const play = recordPitch(DEMO_SCOREBOARD, 'play')
    expect(play.homeScore).equals(DEMO_SCOREBOARD.homeScore)
    expect(play.batterHits).equals(DEMO_SCOREBOARD.batterHits)
    expect(play.pitchCount).equals(DEMO_SCOREBOARD.pitchCount + 1)
  })
})
