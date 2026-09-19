import { expect } from 'chai'
import { describe, it } from 'mocha'

import { earnedRunsByPitcher } from './earnedRuns'

const HOME = 'home-team'
const AWAY = 'away-team'
const P1 = 'pitcher-one'
const P2 = 'pitcher-two'
const BATTERS = ['bat-one', 'bat-two', 'bat-three', 'bat-four', 'bat-five']

let sequence = 0

function row(code: string, attributes: Record<string, unknown> = {}): unknown {
  sequence += 1
  return {
    sequence_number: sequence,
    event_data: { id: `e${sequence}`, code, attributes }
  }
}

/** The away team batting in the top of the first, against one pitcher. */
function opening(pitcherId = P1): unknown[] {
  return [
    row('set_teams', { homeId: HOME, awayId: AWAY }),
    ...BATTERS.map((playerId, index) =>
      row('fill_lineup_index', { teamId: AWAY, playerId, index })
    ),
    row('confirm_end_of_lineup', { teamId: AWAY }),
    row('fill_position', { teamId: HOME, playerId: pitcherId, position: 'P' })
  ]
}

function hit(playResult: string): unknown {
  return row('ball_in_play', { playResult })
}

function er(rows: unknown[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [pitcherId, line] of earnedRunsByPitcher(rows)) {
    out[pitcherId] = line.er
  }
  return out
}

describe('earned runs, by the replayed inning', function () {
  beforeEach(function () {
    sequence = 0
  })

  it('earns a run that four singles drove home', function () {
    expect(
      er([
        ...opening(),
        hit('single'),
        hit('single'),
        hit('single'),
        hit('single')
      ])
    ).to.deep.equal({ [P1]: 1 })
  })

  it('does not earn the run of a man who reached on an error', function () {
    // He crossed the plate and the scoreboard says so. The replay never had
    // him on base at all, which is the whole of the rule: a runner who
    // reached on an error has no earned progress to make.
    expect(
      er([
        ...opening(),
        hit('error'),
        hit('single'),
        hit('single'),
        hit('single')
      ])
    ).to.deep.equal({})
  })

  it('stops earning once the replayed inning would have been over', function () {
    // Two real outs and a man on by an error make three effective outs, so
    // everything after them is unearned however it was scored.
    expect(
      er([
        ...opening(),
        hit('batter_out'),
        hit('batter_out'),
        hit('error'),
        hit('single'),
        hit('single'),
        hit('single'),
        hit('single')
      ])
    ).to.deep.equal({})
  })

  it('charges the run to whoever put the runner on', function () {
    const rows = [
      ...opening(),
      hit('single'),
      row('fill_position', { teamId: HOME, playerId: P2, position: 'P' }),
      hit('single'),
      hit('single'),
      hit('single')
    ]
    expect(er(rows)).to.deep.equal({ [P1]: 1 })
  })

  it('charges a walk to the pitcher who threw its second ball', function () {
    const rows = [
      ...opening(),
      row('pitch', { result: 'ball' }),
      row('pitch', { result: 'ball' }),
      row('fill_position', { teamId: HOME, playerId: P2, position: 'P' }),
      row('pitch', { result: 'ball' }),
      row('pitch', { result: 'ball' }),
      hit('home_run')
    ]
    // The walked man is the first pitcher's doing; the man who hit him home is
    // the second's.
    expect(er(rows)).to.deep.equal({ [P1]: 1, [P2]: 1 })
  })

  it('earns nothing at all from a strikeout', function () {
    expect(
      er([
        ...opening(),
        row('pitch', { result: 'strike_looking' }),
        row('pitch', { result: 'strike_looking' }),
        row('pitch', { result: 'strike_looking' })
      ])
    ).to.deep.equal({})
  })
})
