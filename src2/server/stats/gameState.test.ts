import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type EventContext, walkGame } from './gameState'

const HOME = 'home-team'
const AWAY = 'away-team'

let sequence = 0

function row(code: string, attributes: Record<string, unknown> = {}): unknown {
  sequence += 1
  return {
    sequence_number: sequence,
    event_data: { id: `e${sequence}`, code, attributes }
  }
}

function walk(rows: unknown[]): EventContext[] {
  const seen: EventContext[] = []
  walkGame(rows, { onEvent: context => seen.push(context) })
  return seen
}

/** Two batters for the away side and a pitcher for the home side. */
function opening(): unknown[] {
  return [
    row('set_teams', { homeId: HOME, awayId: AWAY }),
    row('fill_lineup_index', { teamId: AWAY, playerId: 'first', index: 0 }),
    row('fill_lineup_index', { teamId: AWAY, playerId: 'second', index: 1 }),
    row('fill_position', { teamId: HOME, playerId: 'starter', position: 'P' })
  ]
}

describe('walking a game', function () {
  beforeEach(function () {
    sequence = 0
  })

  it('reads the batter from the line-up, in order', function () {
    const seen = walk([
      ...opening(),
      row('ball_in_play', { playResult: 'single' }),
      row('ball_in_play', { playResult: 'single' })
    ])
    expect(seen.at(-2)?.batter).to.equal('first')
    expect(seen.at(-1)?.batter).to.equal('second')
  })

  it('holds at the end of the order until somebody confirms it wraps', function () {
    // Their own end-of-lineup confirmation: a scorer who has entered two
    // batters has not said that the third time round is the first man again,
    // so until they do there is no batter rather than a guess.
    const seen = walk([
      ...opening(),
      row('ball_in_play', { playResult: 'single' }),
      row('ball_in_play', { playResult: 'single' }),
      row('ball_in_play', { playResult: 'single' })
    ])
    expect(seen.at(-1)?.batter).to.equal(undefined)
  })

  it('wraps once it is confirmed', function () {
    const seen = walk([
      ...opening(),
      row('confirm_end_of_lineup', { teamId: AWAY }),
      row('ball_in_play', { playResult: 'single' }),
      row('ball_in_play', { playResult: 'single' }),
      row('ball_in_play', { playResult: 'single' })
    ])
    expect(seen.at(-1)?.batter).to.equal('first')
  })

  it('turns the half over on the third out, with nothing saying so', function () {
    // `end_half` appears 78 times across 95 games. The inning turns over
    // because the outs reached three, and nowhere else.
    const seen = walk([
      ...opening(),
      row('ball_in_play', { playResult: 'batter_out' }),
      row('ball_in_play', { playResult: 'batter_out' }),
      row('ball_in_play', { playResult: 'batter_out' })
    ])
    expect(seen.at(-1)?.after.half).to.equal('bottom')
    expect(seen.at(-1)?.after.outs).to.equal(0)
    expect(seen.at(-1)?.after.lastEvent.endedInning).to.equal(true)
  })

  it('takes the pitcher from the field as it stood before the event', function () {
    const seen = walk([
      ...opening(),
      row('fill_position', {
        teamId: HOME,
        playerId: 'reliever',
        position: 'P'
      }),
      row('pitch', { result: 'ball' })
    ])
    expect(seen.at(-2)?.pitcher).to.equal('starter')
    expect(seen.at(-1)?.pitcher).to.equal('reliever')
  })

  it('walks a batter on the fourth ball without being told', function () {
    const seen = walk([
      ...opening(),
      row('pitch', { result: 'ball' }),
      row('pitch', { result: 'ball' }),
      row('pitch', { result: 'ball' }),
      row('pitch', { result: 'ball' })
    ])
    expect(seen.at(-1)?.after.lastEvent.walk).to.equal(true)
    expect(seen.at(-1)?.after.balls).to.equal(0)
  })

  it('puts the walked man on first, and moves whoever was there', function () {
    const seen = walk([
      ...opening(),
      row('confirm_end_of_lineup', { teamId: AWAY }),
      row('ball_in_play', { playResult: 'single' }),
      row('pitch', { result: 'ball' }),
      row('pitch', { result: 'ball' }),
      row('pitch', { result: 'ball' }),
      row('pitch', { result: 'ball' }),
      row('pitch', { result: 'ball' })
    ])
    // The last event is a pitch after the walk, so the bases it reports are
    // the ones the walk left: the single's man forced to second.
    expect(seen.at(-1)?.playerAtBase(1)).to.equal('second')
    expect(seen.at(-1)?.playerAtBase(2)).to.equal('first')
  })
})
