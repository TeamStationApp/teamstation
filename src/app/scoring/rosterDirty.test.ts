import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { LineupPlayer } from '../../common/api'
import type { GamePlan } from '../../common/gamePlan'
import { copyState } from '../../common/scoring/state'
import { scoringSession } from '../../test/scoringSession'
import {
  addDevelopmentPlayer,
  type createDevelopmentSession
} from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  planDirty,
  planOrderStale,
  rosterDirty,
  rosterSavable,
  sameValue
} from './rosterDirty'

const game = (): ReturnType<typeof createDevelopmentSession> =>
  scoringSession(gameFixture)

const OHTANI: LineupPlayer = {
  gumboId: 660271,
  fullName: 'Shohei Ohtani',
  jersey: '17'
}
const BETTS: LineupPlayer = {
  gumboId: 605141,
  fullName: 'Mookie Betts',
  jersey: '50'
}
const ALONSO: LineupPlayer = {
  gumboId: null,
  fullName: 'Pete Alonso',
  jersey: '20'
}
const SAVED: GamePlan = {
  enabled: false,
  innings: 2,
  rows: [
    { player: OHTANI, cells: ['P', ''] },
    { player: BETTS, cells: ['C', ''] },
    { player: ALONSO, cells: ['1B', ''] }
  ]
}

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
    addDevelopmentPlayer(draft, 'home', 9000000, 'Freddie Freeman', '5')
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

  it('counts a plan changed, and not the order its rows bat in', function () {
    const order = [OHTANI, BETTS, ALONSO]
    expect(planDirty(SAVED, SAVED, order)).equals(false)
    expect(planDirty(undefined, SAVED, order)).equals(false)
    expect(planDirty(SAVED, undefined, order)).equals(false)
    const edited: GamePlan = {
      ...SAVED,
      rows: [{ ...SAVED.rows[0], cells: ['P', 'P'] }, ...SAVED.rows.slice(1)]
    }
    expect(planDirty(edited, SAVED, order)).equals(true)
    expect(planDirty({ ...SAVED, enabled: true }, SAVED, order)).equals(true)
    expect(planDirty({ ...SAVED, innings: 3 }, SAVED, order)).equals(true)
    // Alonso moved to lead off, on this device or another: nothing to save.
    expect(planDirty(SAVED, SAVED, [ALONSO, OHTANI, BETTS])).equals(false)
    expect(planDirty(edited, SAVED, [ALONSO, OHTANI, BETTS])).equals(true)
  })

  it('finds a saved plan batting in another order than the lineup saved, and not a batter added or replaced', function () {
    const order = [OHTANI, BETTS, ALONSO]
    expect(planOrderStale(SAVED, order)).equals(false)
    expect(planOrderStale(undefined, order)).equals(false)
    // Alonso moved to lead off: the saved rows no longer follow the order.
    expect(planOrderStale(SAVED, [ALONSO, OHTANI, BETTS])).equals(true)
    // A batter added or replaced keeps the shared players' order.
    const freeman: LineupPlayer = {
      gumboId: 518692,
      fullName: 'Freddie Freeman',
      jersey: '5'
    }
    expect(planOrderStale(SAVED, [freeman, ...order])).equals(false)
    expect(planOrderStale(SAVED, [OHTANI, freeman, ALONSO])).equals(false)
    // No rows saved: an order alone is nothing to save.
    const none: GamePlan = { enabled: false, innings: 6, rows: [] }
    expect(planOrderStale(none, [ALONSO, OHTANI, BETTS])).equals(false)
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
