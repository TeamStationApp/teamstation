import { expect } from 'chai'
import { describe, it } from 'mocha'

import { storedRecordOf } from '../../src/common/scoring/gumbo'
import { freshGame } from '../../src/common/scoring/lineup'
import {
  asOlderRecord,
  batterActions,
  contextOf,
  type GameSides,
  POSITIONS,
  randomFrom,
  reliefAction,
  scriptedGame
} from './scoredGames'

const sidesWith = (players: number): GameSides => {
  const roster = (base: number): GameSides['home']['players'] =>
    Array.from({ length: players }, (_, i) => ({
      gumboId: base + i,
      first: 'Load',
      last: `Player ${i}`,
      ...(i < POSITIONS.length ? { position: POSITIONS[i] } : {})
    }))
  return {
    away: { id: 'tem_away', name: 'Away', players: roster(1000) },
    home: { id: 'tem_home', name: 'Home', players: roster(2000) }
  }
}

describe('scripted games', function () {
  this.timeout(60_000)

  it('repeats its numbers from a seed', function () {
    const a = randomFrom(5)
    const b = randomFrom(5)
    const c = randomFrom(6)
    const first = [a(), a(), a()]
    expect([b(), b(), b()]).deep.equals(first)
    expect(c()).not.equals(first[0])
    expect(first.every(value => value >= 0 && value < 1)).equals(true)
  })

  it('scores the same game from the same numbers, with its relievers and corrections', async function () {
    const options = {
      innings: 3,
      final: true,
      reliefEvery: 2,
      correctEvery: 3
    }
    const sides = sidesWith(12)
    const one = await scriptedGame('gam_one', sides, {
      ...options,
      random: randomFrom(9)
    })
    const two = await scriptedGame('gam_one', sides, {
      ...options,
      random: randomFrom(9)
    })
    expect(one.plays.length).above(10)
    expect(one.plays.length).equals(two.plays.length)
    expect(one.lineupChanges).above(0)
    expect(one.corrections).above(0)
    const pitches = one.plays.flatMap(play => play.playEvents ?? [])
    expect(pitches.length).above(one.plays.length)
  })

  it('stores a play as each older build did, and reads it back', async function () {
    const sides = sidesWith(12)
    const { plays } = await scriptedGame('gam_old', sides, {
      innings: 1,
      final: false,
      random: randomFrom(3)
    })
    expect(storedRecordOf(plays[0])?.version).equals(3)
    expect(storedRecordOf(asOlderRecord(plays[0], sides, 2))?.version).equals(2)
    expect(storedRecordOf(asOlderRecord(plays[0], sides, 1))?.version).equals(1)
  })

  it('has no reliever once the bench is empty', function () {
    const sides = sidesWith(9)
    const context = contextOf('gam_bench', sides)
    const state = freshGame('gam_bench', context.teams, context.setup)
    expect(reliefAction(state, sides)).equals(undefined)
    const fuller = sidesWith(10)
    const next = contextOf('gam_bench', fuller)
    expect(
      reliefAction(freshGame('gam_bench', next.teams, next.setup), fuller)
    ).deep.include({
      type: 'lineup',
      player: 2009,
      position: 'P',
      side: 'home'
    })
  })

  it('catches a fly with whoever is in center, or nobody', function () {
    const sides = sidesWith(12)
    const context = contextOf('gam_catch', sides)
    const state = freshGame('gam_catch', context.teams, context.setup)
    const fly = batterActions(state, () => 0.9)
    expect(fly).deep.include({
      type: 'result',
      eventType: 'field_out',
      outBy: 'catch'
    })
    state.liveData.boxscore.teams.home.defense.CF = null
    const actions = batterActions(state, () => 0.9)
    expect(JSON.stringify(actions)).not.contains('fielder')
    expect(JSON.stringify(batterActions(state, () => 0.35))).contains(
      'home_run'
    )
    expect(JSON.stringify(batterActions(state, () => 0.5))).contains('"S"')
    expect(JSON.stringify(batterActions(state, () => 0))).not.contains('"S"')
  })
})
