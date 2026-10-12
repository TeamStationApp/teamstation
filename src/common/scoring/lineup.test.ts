import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, game, TEAMS, walk } from '../../test/scoringGames'
import { applyAction } from './apply'
import {
  allocatePlayer,
  applyOverride,
  applyRoster,
  createIdentityMap,
  freshGame,
  newSetup,
  overrideOf,
  validateRoster
} from './lineup'
import { setupOf } from './state'

describe('player identities', function () {
  it('gives one server identity one session id, and a made-up player a new one', function () {
    const map = createIdentityMap()
    expect(allocatePlayer(map, 7)).equals(1)
    expect(allocatePlayer(map, 7)).equals(1)
    expect(allocatePlayer(map, '7')).equals(2)
    expect(allocatePlayer(map, null)).equals(3)
    expect(allocatePlayer(map, null)).equals(4)
    map.sessionToSource[5] = 'taken'
    expect(allocatePlayer(map, 9)).equals(6)
  })

  it('refuses to hand out an id past the safe range', function () {
    const map = createIdentityMap()
    map.nextId = Number.MAX_SAFE_INTEGER + 1
    expect(() => allocatePlayer(map, null)).to.throw(
      'Local player identifiers exhausted'
    )
  })
})

describe('a new game from two rosters', function () {
  it('takes the rostered players, tops each side up to nine, and fills the field', function () {
    const setup = newSetup(TEAMS, {
      away: [
        {
          userId: 501,
          shortName: 'Ace P',
          positions: ['SS', 'P'],
          bats: 'left',
          throws: 'left',
          jersey: '7'
        },
        { userId: 502, shortName: 'Cat C', positions: ['C'] }
      ],
      home: []
    })
    const away = setup.sides.away
    expect(away.players).length(9)
    expect(setup.players[1]).includes({
      userId: 501,
      fullName: 'Ace P',
      bats: 'left',
      local: false
    })
    expect(setup.players[3]).includes({
      userId: null,
      fullName: 'Player 3',
      local: true
    })
    expect(away.defense.P).equals(1)
    expect(away.defense.C).equals(2)
    expect(away.defense['1B']).equals(3)
    expect(away.defense.SS).equals(5)
    const state = freshGame('g2', TEAMS, setup)
    expect(state.liveData.linescore.offense.batter!.id).equals(1)
    expect(state.liveData.plays.currentPlay!.matchup.batSide.code).equals('L')
    expect(state.liveData.linescore.defense.P!.id).equals(10)
  })

  it('refuses a player listed twice', function () {
    expect(() =>
      newSetup(TEAMS, {
        away: [
          { userId: 1, shortName: 'A' },
          { userId: 1, shortName: 'A' }
        ],
        home: []
      })
    ).to.throw('Player appears more than once in the game roster')
  })
})

describe('roster checks', function () {
  it('updates a current batter’s edited hand before the first pitch without rewriting pitched appearances or manual choices', function () {
    const state = game()
    const setup = setupOf(state)
    setup.players[1].bats = 'left'
    const edited = applyAction(state, { type: 'lineup', kind: 'roster', setup })
    expect(edited.problems).deep.equals([])
    expect(edited.state.gameData.players[1].bats).equals('left')
    expect(
      edited.state.liveData.plays.currentPlay!.matchup.batSide.code
    ).equals('L')
    const pitched = after(state, { type: 'pitch', call: 'B' })
    const events = structuredClone(
      pitched.liveData.plays.currentPlay!.playEvents
    )
    const afterPitch = applyAction(pitched, {
      type: 'lineup',
      kind: 'roster',
      setup
    })
    expect(afterPitch.problems).deep.equals([])
    expect(afterPitch.state.gameData.players[1].bats).equals('left')
    expect(
      afterPitch.state.liveData.plays.currentPlay!.matchup.batSide.code
    ).equals('R')
    expect(afterPitch.state.liveData.plays.currentPlay!.playEvents).deep.equals(
      events
    )
    state.gameData.players[1].bats = 'switch'
    const switched = after(state, {
      type: 'lineup',
      kind: 'batterSide',
      batSide: 'L'
    })
    const unrelated = setupOf(switched)
    unrelated.players[2].jersey = '00'
    expect(
      applyRoster(switched, unrelated).state!.liveData.plays.currentPlay!
        .matchup.batSide.code
    ).equals('L')
    unrelated.players[1].bats = 'right'
    expect(
      applyRoster(switched, unrelated).state!.liveData.plays.currentPlay!
        .matchup.batSide.code
    ).equals('R')
  })
  it('says what is wrong with a lineup', function () {
    const check = (
      edit: (setup: ReturnType<typeof setupOf>) => void
    ): string | undefined => {
      const setup = setupOf(game())
      edit(setup)
      return validateRoster({
        gameData: { teams: TEAMS, players: setup.players },
        liveData: { boxscore: { teams: setup.sides } }
      })
    }
    expect(check(() => undefined)).equals(undefined)
    expect(check(s => (s.sides.away.battingOrder = []))).equals(
      'Visitors needs a lineup.'
    )
    expect(check(s => s.sides.away.battingOrder.push(1))).equals(
      'Visitors has an invalid or duplicate lineup player.'
    )
    expect(check(s => (s.sides.home.defense.P = null))).equals(
      'Hosts needs a pitcher.'
    )
    expect(check(s => (s.sides.home.defense.C = 3))).equals(
      'Hosts has an invalid or duplicate defender.'
    )
  })

  it('keeps the batter due, or finds the next one still in the order', function () {
    const state = game()
    const setup = setupOf(state)
    setup.sides.away.battingOrder = [2, 3, 4, 5, 6, 7, 8, 9]
    const applied = applyRoster(state, setup)
    expect(applied.state!.liveData.linescore.offense.batter!.id).equals(2)
    expect(applied.state!.liveData.plays.currentPlay!.matchup.batter.id).equals(
      2
    )
  })

  it('refuses a next batter who is already on base', function () {
    const state = walk(game())
    const setup = setupOf(state)
    setup.sides.away.battingOrder = [1]
    expect(applyRoster(state, setup).error).equals(
      'Choose a next batter in the lineup who is not already on base.'
    )
  })

  it('opens a play for a batter when there was none', function () {
    const state = game()
    state.liveData.plays.currentPlay = null
    const applied = applyRoster(state, setupOf(state))
    expect(applied.state!.liveData.plays.currentPlay!.matchup.batter.id).equals(
      1
    )
  })
})

describe('correcting the game state by hand', function () {
  it('sets the half, the score, the count, the batter, the pitcher and the bases', function () {
    const state = game()
    const draft = {
      ...overrideOf(state),
      inning: 4,
      top: false,
      awayScore: 3,
      homeScore: 1,
      balls: 2,
      strikes: 1,
      outs: 2,
      batter: 12,
      pitcher: 2,
      bases: [13, null, 14]
    }
    const next = applyOverride(state, draft).state!
    const line = next.liveData.linescore
    expect(line).includes({
      currentInning: 4,
      currentInningOrdinal: '4th',
      inningState: 'Bottom',
      balls: 2,
      strikes: 1,
      outs: 2
    })
    expect(line.offense.batter!.id).equals(12)
    expect(line.offense.first!.id).equals(13)
    expect(line.defense.P!.id).equals(2)
    expect(next.liveData.boxscore.teams.away.defense.P).equals(2)
    expect(next.liveData.boxscore.teams.away.defense.C).equals(null)
    expect(next.liveData.plays.currentPlay!.matchup.batter.id).equals(12)
  })

  it('keeps the play when only the count and the batter change', function () {
    const state = after(game(), { type: 'pitch', call: 'B' })
    const next = applyOverride(state, {
      ...overrideOf(state),
      strikes: 2,
      batter: 5
    }).state!
    const play = next.liveData.plays.currentPlay!
    expect(play.playEvents).length(1)
    expect(play.count).deep.equals({ balls: 1, strikes: 2, outs: 0 })
    expect(play.matchup.batter.id).equals(5)
  })

  it('says what a correction may not do', function () {
    const state = game()
    const base = overrideOf(state)
    expect(applyOverride(state, { ...base, balls: 4 }).error).includes(
      'balls 0–3'
    )
    expect(applyOverride(state, { ...base, batter: 12 }).error).equals(
      'Choose a batter from the batting team lineup.'
    )
    expect(
      applyOverride(state, { ...base, bases: [1, null, null] }).error
    ).includes('cannot include the batter')
    expect(applyOverride(state, { ...base, pitcher: 3 }).error).equals(
      'Choose a pitcher from the fielding team.'
    )
  })

  it('is a game-flow action', function () {
    const state = after(game(), {
      type: 'gameFlow',
      kind: 'override',
      awayScore: 5,
      bases: [2]
    })
    expect(state.liveData.linescore.teams.away.runs).equals(5)
    expect(state.liveData.linescore.offense.first!.id).equals(2)
    expect(
      applyAction(game(), {
        type: 'gameFlow',
        kind: 'override',
        pitcher: 3
      }).problems[0].message
    ).equals('Choose a pitcher from the fielding team.')
  })
})
