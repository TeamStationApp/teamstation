import { expect } from 'chai'
import { describe, it } from 'mocha'

import { copyState } from '../../common/scoring/state'
import {
  addDevelopmentPlayer,
  createDevelopmentSession
} from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { rosterDirty, rosterSavable, sameValue } from './rosterDirty'

const game = (): ReturnType<typeof createDevelopmentSession> =>
  createDevelopmentSession(gameFixture, [], [])

describe('roster draft dirty check', function () {
  it('is clean on open', function () {
    const base = game()
    expect(rosterDirty(base, copyState(base))).equals(false)
    expect(rosterDirty(base, copyState(base), [], undefined)).equals(false)
  })

  it('is dirty after a reorder, and clean once it is undone by hand', function () {
    const base = game()
    const draft = copyState(base)
    const order = draft.liveData.boxscore.teams.home.battingOrder
    ;[order[0], order[1]] = [order[1], order[0]]
    expect(rosterDirty(base, draft)).equals(true)
    ;[order[0], order[1]] = [order[1], order[0]]
    expect(rosterDirty(base, draft)).equals(false)
  })

  it('is dirty after a defense change, and clean with the same defense in another key order', function () {
    const base = game()
    const draft = copyState(base)
    const team = draft.liveData.boxscore.teams.away
    const pitcher = team.defense.P
    team.defense.P = team.defense.C
    team.defense.C = pitcher
    expect(rosterDirty(base, draft)).equals(true)
    const reordered = copyState(base)
    const defense = reordered.liveData.boxscore.teams.away.defense
    reordered.liveData.boxscore.teams.away.defense = Object.fromEntries(
      Object.entries(defense).reverse()
    ) as typeof defense
    expect(
      Object.keys(reordered.liveData.boxscore.teams.away.defense)
    ).not.deep.equals(Object.keys(defense))
    expect(rosterDirty(base, reordered)).equals(false)
  })

  it('is dirty after an added player', function () {
    const base = game()
    const draft = copyState(base)
    addDevelopmentPlayer(draft, 'home', 'Freddie Freeman', '5')
    expect(rosterDirty(base, draft)).equals(true)
  })

  it('is dirty with a staged runner or a changed next batter', function () {
    const base = game()
    const batter = base.liveData.boxscore.teams.away.battingOrder[2]
    expect(
      rosterDirty(base, copyState(base), [{ base: '2B', player: batter }])
    ).equals(true)
    expect(rosterDirty(base, copyState(base), [], batter)).equals(true)
    expect(rosterDirty(base, copyState(base), [], batter, batter)).equals(false)
  })

  it('lights Save for a change or a lineup not yet accepted, when the draft validates', function () {
    // A clean draft of an accepted lineup waits for a change.
    expect(rosterSavable(false, false, undefined)).equals(false)
    expect(rosterSavable(true, false, undefined)).equals(true)
    // A lineup the game does not hold yet is saved as it stands to accept it.
    expect(rosterSavable(false, true, undefined)).equals(true)
    expect(rosterSavable(true, true, undefined)).equals(true)
    // A draft that does not validate is never saved.
    expect(rosterSavable(true, false, 'No players in lineup')).equals(false)
    expect(rosterSavable(false, true, 'No players in lineup')).equals(false)
  })

  it('compares plain data by value, whatever the key order', function () {
    expect(
      sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })
    ).equals(true)
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).equals(true)
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).equals(false)
    expect(sameValue({ a: 1, b: undefined }, { a: 1, c: 2 })).equals(false)
    expect(sameValue({ a: undefined, b: 1 }, { c: undefined, b: 1 })).equals(
      true
    )
    expect(sameValue({ a: 1 }, { b: 1 })).equals(false)
    expect(sameValue([1, 2], [1, 2, 3])).equals(false)
    expect(sameValue([1, 2], { 0: 1, 1: 2 })).equals(false)
    expect(sameValue({ 0: 1 }, [1])).equals(false)
    expect(sameValue(null, {})).equals(false)
    expect(sameValue(1, '1')).equals(false)
    expect(sameValue(null, null)).equals(true)
  })
})
