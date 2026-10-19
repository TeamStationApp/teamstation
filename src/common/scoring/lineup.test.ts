import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, game, TEAMS, walk } from '../../test/scoringGames'
import { applyAction } from './apply'
import {
  addPlayer,
  applyOverride,
  applyRoster,
  freshGame,
  newSetup,
  overrideOf,
  validateRoster
} from './lineup'
import { applyRosterCommands, rosterSituation } from './rosterCommands'
import { setupOf } from './state'

describe('player identities', function () {
  it('keeps sparse persistent identities and rejects invalid or duplicate guests', function () {
    const state = game()
    const id = Number.MAX_SAFE_INTEGER
    expect(addPlayer(state, 'away', id, 'Babe Ruth')).equals(id)
    expect(state.gameData.players[id].id).equals(id)
    expect(state.meta.tagOrder.at(-1)).equals(id)
    const before = structuredClone(state)
    for (const invalid of [id, 0, -1, 1.5, Infinity, id + 1])
      expect(() => addPlayer(state, 'home', invalid, 'Willie Mays')).throws()
    expect(state).deep.equals(before)
  })
})

describe('a new game from two rosters', function () {
  it('keeps only persisted players and fills their available positions', function () {
    const setup = newSetup(TEAMS, {
      away: [
        {
          userId: 501,
          shortName: 'Albert P',
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
    expect(away.players).deep.equals([501, 502])
    expect(setup.players[501]).includes({
      userId: 501,
      fullName: 'Albert P',
      bats: 'left',
      local: false
    })
    expect(setup.players[3]).equals(undefined)
    expect(away.defense.P).equals(501)
    expect(away.defense.C).equals(502)
    expect(away.defense['1B']).equals(null)
    expect(away.defense.SS).equals(null)
    const state = freshGame('g2', TEAMS, setup)
    expect(state.liveData.linescore.offense.batter!.id).equals(501)
    expect(state.liveData.plays.currentPlay).equals(null)
    expect(state.liveData.linescore.defense.P).equals(null)
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

  it('bats each side from the top of its new order before the game has begun', function () {
    const state = game()
    const setup = setupOf(state)
    setup.sides.away.battingOrder = [2, 3, 1, 4, 5, 6, 7, 8, 9]
    setup.sides.home.battingOrder = [12, 10, 11, 13, 14, 15, 16, 17, 18]
    const applied = applyAction(state, {
      type: 'lineup',
      kind: 'roster',
      setup
    })
    expect(applied.problems).deep.equals([])
    const teams = applied.state.liveData.boxscore.teams
    expect(teams.away.battingIndex).equals(0)
    expect(teams.home.battingIndex).equals(0)
    expect(applied.state.liveData.linescore.offense.batter!.id).equals(2)
    expect(applied.state.liveData.plays.currentPlay!.matchup.batter.id).equals(
      2
    )
  })

  it('bats whoever leads off once the old leadoff is replaced before the game', function () {
    const state = game()
    const draft = structuredClone(state)
    const bench = addPlayer(draft, 'away', 19, 'Lindor')
    const order = draft.liveData.boxscore.teams.away.battingOrder
    order[0] = bench
    const due = (): number =>
      applyRoster(state, setupOf(draft)).state!.liveData.linescore.offense
        .batter!.id
    expect(due()).equals(bench)
    // The man who took the leadoff's place bats fifth: the new leadoff is due.
    order.splice(0, 1)
    order.splice(4, 0, bench)
    expect(order.slice(0, 5)).deep.equals([2, 3, 4, 5, bench])
    expect(due()).equals(2)
  })

  it('keeps the batter due through a reorder once the first pitch is thrown', function () {
    const state = after(game(), { type: 'pitch', call: 'B' })
    const setup = setupOf(state)
    setup.sides.away.battingOrder = [2, 3, 1, 4, 5, 6, 7, 8, 9]
    const applied = applyAction(state, {
      type: 'lineup',
      kind: 'roster',
      setup
    })
    expect(applied.problems).deep.equals([])
    expect(applied.state.liveData.linescore.offense.batter!.id).equals(1)
    expect(applied.state.liveData.boxscore.teams.away.battingIndex).equals(2)
  })

  it('bats the leadoff of a lineup dictated and saved before the game (R1, R3, R6)', function () {
    const state = game()
    const situation = rosterSituation(state)
    const fourth = applyRosterCommands(
      state,
      [
        {
          type: 'placeInLineup',
          side: 'away',
          places: [{ player: 1, slot: 4 }]
        }
      ],
      situation
    )
    if ('problem' in fourth) throw new Error(fourth.problem)
    expect(fourth.draft.liveData.boxscore.teams.away.battingOrder).deep.equals([
      2, 3, 4, 1, 5, 6, 7, 8, 9
    ])
    const nine = applyRosterCommands(
      fourth.draft,
      [{ type: 'setLineup', side: 'away', order: [3, 2, 1, 4, 5, 6, 7, 8, 9] }],
      situation
    )
    if ('problem' in nine) throw new Error(nine.problem)
    const saved = applyAction(state, {
      type: 'lineup',
      kind: 'roster',
      setup: setupOf(nine.draft)
    })
    expect(saved.problems).deep.equals([])
    expect(saved.state.liveData.linescore.offense.batter!.id).equals(3)
    expect(saved.state.liveData.plays.currentPlay!.matchup.batter.id).equals(3)
    const pitched = after(saved.state, { type: 'pitch', call: 'B' })
    expect(pitched.liveData.plays.currentPlay!.matchup.batter.id).equals(3)
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
