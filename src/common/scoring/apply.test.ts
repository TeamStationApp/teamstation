import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  after,
  ball,
  bases,
  close,
  F,
  game,
  outs,
  play,
  runs,
  strike,
  strikeout,
  walk
} from '../../test/scoringGames'
import type { ScoringAction } from './actions'
import { applyAction, applyActions } from './apply'
import { setupOf } from './state'

const pitch = (call: 'B' | 'C' | 'S' | 'F' | 'T' | 'L'): ScoringAction => ({
  type: 'pitch',
  call
})
const count = (state: ReturnType<typeof game>): string => {
  const line = state.liveData.linescore
  return `${line.balls}-${line.strikes}`
}

describe('applying pitches', function () {
  it('moves the count for each call', function () {
    let state = game()
    const seen: string[] = []
    for (const call of ['B', 'C', 'S'] as const) {
      state = after(state, pitch(call))
      seen.push(count(state))
    }
    expect(seen).deep.equals(['1-0', '1-1', '1-2'])
    expect(count(after(state, pitch('F')))).equals('1-2')
    expect(count(after(game(), pitch('F')))).equals('0-1')
    const pitches = state.liveData.plays.currentPlay!.playEvents
    expect(pitches.map(event => event.details.code)).deep.equals([
      'B',
      'C',
      'S'
    ])
    // Each pitch carries the count it left.
    expect(pitches.map(event => event.count)).deep.equals([
      { balls: 1, strikes: 0, outs: 0 },
      { balls: 1, strikes: 1, outs: 0 },
      { balls: 1, strikes: 2, outs: 0 }
    ])
    expect(state.liveData.boxscore.teams.home.pitchCounts[F.P]).equals(3)
  })

  it('strikes out on a foul tip or a foul bunt with two strikes', function () {
    for (const call of ['T', 'L'] as const) {
      const state = after(game(), strike, strike, pitch(call), close)
      expect(outs(state), call).equals(1)
      expect(state.liveData.plays.allPlays[0].result.eventType).equals(
        'strikeout'
      )
    }
  })

  it('walks on ball four and forces the runner on first to second', function () {
    let state = walk(game())
    expect(bases(state)).deep.equals([1, null, null])
    const first = state.liveData.plays.allPlays[0]
    expect(first.result).includes({ event: 'Walk', eventType: 'walk' })
    expect(first.about.isComplete).equals(true)
    state = walk(state)
    expect(bases(state)).deep.equals([2, 1, null])
    expect(runs(state)).equals(0)
  })

  it('scores the forced runner with bases loaded, batted in', function () {
    let state = game()
    for (let i = 0; i < 4; i++) state = walk(state)
    expect(bases(state)).deep.equals([4, 3, 2])
    expect(runs(state)).equals(1)
    const fourth = state.liveData.plays.allPlays[3]
    expect(fourth.result.rbi).equals(1)
    expect(fourth.runners.map(r => r.movement.end)).deep.equals([1, 2, 3, 4])
    expect(fourth.runners[3].movement.runScored).equals(true)
  })

  it('is an out on strike three, and a foul with two strikes adds no strike', function () {
    let state = after(game(), strike, strike, pitch('F'), pitch('F'))
    expect(count(state)).equals('0-2')
    state = after(state, strike, close)
    expect(outs(state)).equals(1)
    const out = state.liveData.plays.allPlays[0]
    expect(out.runners[0].movement).includes({ isOut: true, outNumber: 1 })
    expect(out.result.event).equals('Strikeout')
  })

  it('brings up the next batter once per appearance', function () {
    let state = game()
    expect(state.liveData.plays.currentPlay!.about.atBatIndex).equals(0)
    expect(state.liveData.linescore.offense.batter!.id).equals(1)
    state = strikeout(state)
    expect(state.liveData.plays.currentPlay!.about.atBatIndex).equals(1)
    expect(state.liveData.linescore.offense.batter!.id).equals(2)
    expect(state.liveData.plays.allPlays).length(1)
    expect(count(state)).equals('0-0')
    state = after(state, ball)
    expect(state.liveData.plays.currentPlay!.about.atBatIndex).equals(1)
  })

  it('ends the half on the third out and starts the other side', function () {
    let state = game()
    for (let i = 0; i < 3; i++) state = strikeout(state)
    const line = state.liveData.linescore
    expect(line.isTopInning).equals(false)
    expect(line.inningState).equals('Bottom')
    expect(outs(state)).equals(0)
    expect(line.offense.batter!.id).equals(10)
    expect(line.defense.P!.id).equals(1)
    for (let i = 0; i < 3; i++) state = strikeout(state)
    expect(state.liveData.linescore.currentInning).equals(2)
    expect(state.liveData.linescore.currentInningOrdinal).equals('2nd')
    expect(state.liveData.linescore.offense.batter!.id).equals(4)
  })
})

describe('applying plate-appearance results', function () {
  it('hits a single: batter to first, a hit for the side', function () {
    const applied = play(
      game(),
      {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 15,
        location: { x: 5, z: -60 },
        fielder: F.CF
      },
      { type: 'result', eventType: 'single' }
    )
    const state = applied.state
    expect(bases(state)).deep.equals([1, null, null])
    expect(state.liveData.linescore.teams.away.hits).equals(1)
    const current = state.liveData.plays.currentPlay!
    expect(current.hitData).deep.includes({
      launchAngle: 15,
      trajectory: 'Line Drive',
      coordinates: { x: 5, z: -60 }
    })
    expect(current.playEvents.at(-1)!.details).deep.equals({
      call: { code: 'X', description: 'Ball in Play' },
      code: 'X',
      description: 'Ball in Play',
      isInPlay: true
    })
    expect(current.result).includes({ event: 'Single', eventType: 'single' })
    // Nobody left to decide: the play waits only to be closed.
    const closed = after(state, close)
    expect(closed.liveData.plays.allPlays[0].about.isComplete).equals(true)
    expect(closed.liveData.linescore.offense.batter!.id).equals(2)
  })

  it('closes a decided play by itself when the next pitch comes', function () {
    let state = after(game(), { type: 'result', eventType: 'double' }, ball)
    expect(state.liveData.plays.allPlays[0].result.eventType).equals('double')
    expect(bases(state)).deep.equals([null, 1, null])
    expect(count(state)).equals('1-0')
    state = after(state, { type: 'result', eventType: 'triple' })
    expect(runs(state)).equals(0)
    expect(state.homeQueue).deep.equals([1])
  })

  it('offers no out-of-the-park home run on a bunt', function () {
    const applied = applyActions(game(), [
      { type: 'ballInPlay', contact: 'bunt' },
      { type: 'result', eventType: 'home_run' }
    ])
    expect(applied.problems[0].message).equals('A bunt cannot be a home run')
    expect(
      applied.state.liveData.plays.currentPlay!.playEvents.at(-1)!.details
        .description
    ).equals('Bunt in Play')
  })

  it('scores everyone on a home run past the wall', function () {
    const state = after(
      walk(game()),
      {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 30,
        location: { x: 0, z: -130 }
      },
      { type: 'result', eventType: 'home_run' },
      close
    )
    expect(runs(state)).equals(2)
    const hr = state.liveData.plays.allPlays[1]
    expect(hr.source.gamestation.homeRunKind).equals('out-of-park')
    expect(hr.result.rbi).equals(2)
    expect(bases(state)).deep.equals([null, null, null])
  })

  it('calls a home run inside the fence in the park, and keeps no kind on other hits', function () {
    const inside = after(
      game(),
      {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 20,
        location: { x: 0, z: -100 },
        fielder: F.CF,
        landingHeight: 2
      },
      { type: 'result', eventType: 'home_run' },
      close
    )
    expect(inside.liveData.plays.allPlays[0].source.gamestation).includes({
      homeRunKind: 'in-park',
      landingHeight: 2
    })
    const hit = after(
      game(),
      {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 20,
        location: { x: 0, z: -130 },
        landingHeight: 2
      },
      { type: 'result', eventType: 'double' }
    )
    expect(
      hit.liveData.plays.currentPlay!.source.gamestation
    ).not.to.have.any.keys('homeRunKind', 'landingHeight')
  })

  it("refuses a fielder's choice with nobody on base", function () {
    const applied = applyAction(game(), {
      type: 'result',
      eventType: 'fielders_choice'
    })
    expect(applied.problems[0].code).equals('illegal')
    expect(applied.state).equals(applied.state)
  })

  it('makes the catch an out at once, and a caught foul says so', function () {
    const state = after(
      game(),
      {
        type: 'ballInPlay',
        contact: 'swing',
        launchAngle: 50,
        location: { x: 30, z: 5 },
        fielder: F['1B']
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      close
    )
    expect(outs(state)).equals(1)
    const caught = state.liveData.plays.allPlays[0]
    expect(caught.source.gamestation).includes({
      outSubtype: 'Ball Caught',
      foulCaught: true
    })
    expect(caught.result.description).equals('Foul ball caught')
    expect(caught.runners[0].credits.map(c => c.credit)).deep.equals([
      'f_putout'
    ])
  })

  it('awards first on a hit by pitch, an intentional walk and interference', function () {
    for (const [eventType, label] of [
      ['hit_by_pitch', 'Hit by Pitch'],
      ['intent_walk', 'Intentional Walk'],
      ['catcher_interference', "Catcher's Interference"]
    ] as const) {
      const state = after(walk(game()), { type: 'result', eventType }, close)
      expect(bases(state), eventType).deep.equals([2, 1, null])
      const award = state.liveData.plays.allPlays[1]
      expect(award.result).includes({ event: label, eventType })
      expect(award.playEvents.at(-1)!.isPitch).equals(
        eventType === 'hit_by_pitch'
      )
    }
  })

  it('puts the batter on a base by hand, only with the bases empty', function () {
    const state = after(
      game(),
      { type: 'result', eventType: 'manual_placement', base: '2B' },
      close
    )
    expect(bases(state)).deep.equals([null, 1, null])
    expect(state.liveData.plays.allPlays[0].result.eventType).equals(
      'manual_placement'
    )
    const refused = applyAction(state, {
      type: 'result',
      eventType: 'manual_placement'
    })
    expect(refused.problems[0].message).equals('Requires empty bases')
  })

  it('refuses a batted-ball result without the ball in play being a batted ball', function () {
    const inPlay = after(game(), { type: 'ballInPlay', contact: 'swing' })
    expect(
      applyAction(inPlay, { type: 'result', eventType: 'hit_by_pitch' })
        .problems[0].message
    ).equals('A ball in play needs a batted-ball result')
    const refined = applyAction(inPlay, {
      type: 'ballInPlay',
      contact: 'swing',
      launchAngle: 20,
      location: { x: 1, z: -50 }
    })
    expect(refined.problems).deep.equals([])
    const events = refined.state.liveData.plays.currentPlay!.playEvents
    expect(events.filter(event => event.isPitch)).length(1)
    expect(
      refined.state.liveData.plays.currentPlay!.hitData?.launchAngle
    ).equals(20)
    expect(
      applyAction(inPlay, { type: 'ballInPlay', contact: 'bunt' }).problems[0]
        .message
    ).equals('The ball is already in play as a different contact')
    expect(applyAction(inPlay, ball).problems[0].message).equals(
      'A ball in play needs its result'
    )
    expect(
      applyAction(inPlay, {
        type: 'ballInPlay',
        contact: 'swing',
        fielder: 3
      }).problems[0].code
    ).equals('unknownPlayer')
    expect(
      applyAction(game(), {
        type: 'ballInPlay',
        contact: 'swing',
        fielder: 3
      }).problems[0].message
    ).equals('That player is not in the field')
  })

  it('refuses a pitch while a play is still being decided', function () {
    const state = after(game(), { type: 'result', eventType: 'field_out' })
    const refused = applyAction(state, ball)
    expect(refused.problems).deep.equals([
      { code: 'notNow', message: 'Finish the current play first' }
    ])
    expect(refused.state).equals(state)
    expect(refused.transitions).deep.equals([])
  })

  it('answers an action it cannot read with a problem', function () {
    const state = game()
    const nope: unknown = { type: 'nope' }
    const refused = applyAction(state, nope as ScoringAction)
    expect(refused.problems[0].code).equals('unknownAction')
    expect(refused.state).equals(state)
  })
})

describe('applying lineup changes', function () {
  it('substitutes a player into the same slot and position', function () {
    let state = after(game(), {
      type: 'lineup',
      kind: 'addPlayer',
      side: 'home',
      name: '  New Kid ',
      jersey: '42'
    })
    const kid = state.liveData.boxscore.teams.home.players.at(-1)!
    expect(state.gameData.players[kid]).includes({
      fullName: 'New Kid',
      userId: null,
      local: true,
      jersey: '42'
    })
    state = after(state, {
      type: 'lineup',
      kind: 'substitute',
      side: 'home',
      player: kid,
      replaces: F.SS
    })
    const home = state.liveData.boxscore.teams.home
    expect(home.battingOrder).length(9)
    expect(home.battingOrder[4]).equals(kid)
    expect(home.defense.SS).equals(kid)
    expect(state.liveData.linescore.defense.SS!.id).equals(kid)
  })

  it('refuses a player in two positions and moves one who changes position', function () {
    const twice = setupOf(game())
    twice.sides.home.defense.SS = F['2B']
    const refused = applyAction(game(), {
      type: 'lineup',
      kind: 'roster',
      setup: twice
    })
    expect(refused.problems[0].message).equals(
      'Hosts has an invalid or duplicate defender.'
    )
    const moved = after(game(), {
      type: 'lineup',
      kind: 'position',
      side: 'home',
      position: 'SS',
      player: F['2B']
    })
    expect(moved.liveData.boxscore.teams.home.defense).includes({
      SS: F['2B'],
      '2B': null
    })
  })

  it('sets a batting order and brings up whoever is due in it', function () {
    const state = after(game(), {
      type: 'lineup',
      kind: 'battingOrder',
      side: 'away',
      order: [9, 8, 7, 6, 5, 4, 3, 2, 1]
    })
    expect(state.liveData.linescore.offense.batter!.id).equals(1)
    const next = strikeout(state)
    expect(next.liveData.linescore.offense.batter!.id).equals(9)
  })

  it('turns the batter around before the first pitch only', function () {
    const state = after(game(), {
      type: 'lineup',
      kind: 'batterSide',
      batSide: 'L'
    })
    expect(state.liveData.plays.currentPlay!.matchup.batSide.code).equals('L')
    const late = applyAction(after(state, ball), {
      type: 'lineup',
      kind: 'batterSide',
      batSide: 'R'
    })
    expect(late.problems[0].code).equals('notNow')
  })

  it('asks for the pieces a lineup change needs', function () {
    for (const action of [
      { type: 'lineup', kind: 'battingOrder' },
      { type: 'lineup', kind: 'battingOrder', side: 'home' },
      { type: 'lineup', kind: 'position', side: 'home' },
      { type: 'lineup', kind: 'substitute', side: 'home', player: 3 },
      { type: 'lineup', kind: 'roster', side: 'home' }
    ] as ScoringAction[])
      expect(applyAction(game(), action).problems[0].code).equals('malformed')
  })

  it('makes a lineup change wait for the play being decided', function () {
    const state = after(game(), { type: 'result', eventType: 'field_out' })
    expect(
      applyAction(state, {
        type: 'lineup',
        kind: 'batterSide',
        batSide: 'L'
      }).problems[0].message
    ).equals('Finish the current play first')
  })

  it('waits for a lineup change when the batter due is on base', function () {
    let state = game()
    // Nine walks put the whole order through; the tenth batter due is on base.
    for (let i = 0; i < 3; i++) state = walk(state)
    state = after(state, {
      type: 'lineup',
      kind: 'battingOrder',
      side: 'away',
      order: [4, 1, 2, 3, 5, 6, 7, 8, 9]
    })
    expect(state.liveData.linescore.offense.batter!.id).equals(4)
    state = strikeout(state)
    expect(state.awaitingBatter).deep.equals({
      teamId: 'team-away',
      dueIndex: 1,
      duePlayerId: 1
    })
    expect(state.liveData.plays.currentPlay).equals(null)
    expect(applyAction(state, ball).problems[0].message).equals(
      'The batter due is on base: change the lineup first'
    )
    state = after(state, {
      type: 'lineup',
      kind: 'roster',
      setup: setupOf(state),
      nextBatter: 5
    })
    expect(state.awaitingBatter).equals(null)
    expect(state.liveData.linescore.offense.batter!.id).equals(5)
  })
})

describe('applying in place', function () {
  it('changes the given game rather than a copy, to the same result', function () {
    const kept = after(game(), ball)
    const before = JSON.stringify(kept)
    const copied = applyAction(kept, pitch('C'))
    expect(JSON.stringify(kept)).equals(before)
    const own = JSON.parse(before) as typeof kept
    const inPlace = applyAction(own, pitch('C'), { inPlace: true })
    expect(inPlace.state).equals(own)
    expect(count(own)).equals('1-1')
    expect(JSON.stringify(inPlace.state)).equals(JSON.stringify(copied.state))
    expect(inPlace.transitions).deep.equals(copied.transitions)
  })
})
