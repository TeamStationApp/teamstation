import { expect } from 'chai'
import { describe, it } from 'mocha'

import { game, TEAMS } from '../../test/scoringGames'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { FINAL_INDEX } from './gumbo'
import {
  playsLost,
  playsLostText,
  resetsPlays,
  resetWarning
} from './playsLost'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from './session'
import { setupOf } from './state'

/** A server in memory, holding what the session saves. */
class Store implements EventStore {
  plays: GumboPlay[] = []
  current: CurrentPlay | null = null

  async load(): Promise<StoredGame> {
    return { plays: this.plays, currentPlay: this.current }
  }

  async save(_gameId: string, change: SaveChange): Promise<StoredGame> {
    const kept = new Map(
      this.plays.map(play => [play.about.atBatIndex, play] as const)
    )
    for (const index of change.remove ?? []) kept.delete(index)
    for (const play of change.plays) kept.set(play.about.atBatIndex, play)
    this.plays = [...kept.values()]
    if (change.currentPlay !== undefined) this.current = change.currentPlay
    return await this.load()
  }
}

const context = { gamePk: 'g1', teams: TEAMS, setup: setupOf(game()) }
const roster: ScoringAction = {
  type: 'lineup',
  kind: 'roster',
  setup: setupOf(game()),
  confirmed: ['away', 'home']
}
const strike: ScoringAction = { type: 'pitch', call: 'C' }
/** Three called strikes: one strikeout. */
const strikeout = [strike, strike, strike]
/** Three strikeouts: a half-inning. */
const half = [...strikeout, ...strikeout, ...strikeout]

async function scored(actions: ScoringAction[]): Promise<Store> {
  const store = new Store()
  const session = await ScoringSession.open(store, 'g1', context)
  for (const action of [roster, ...actions])
    expect(session.apply(action).problems, JSON.stringify(action)).deep.equals(
      []
    )
  await session.flush()
  return store
}

describe('the plays a reset loses', function () {
  it('counts nothing before the first pitch', async function () {
    const store = await scored([])
    expect(playsLost(await store.load())).deep.equals({ atBats: 0, innings: 0 })
  })

  it('counts an at-bat in progress once it holds a pitch', async function () {
    const store = await scored([{ type: 'pitch', call: 'B' }])
    expect(store.plays).deep.equals([])
    expect(playsLost(await store.load())).deep.equals({ atBats: 1, innings: 1 })
  })

  it('counts completed plate appearances, and the at-bat after them only once it begins', async function () {
    // The strikeout is still the at-bat in progress until the next begins.
    const store = await scored(strikeout)
    expect(store.plays).deep.equals([])
    expect(playsLost(await store.load())).deep.equals({ atBats: 1, innings: 1 })
    const pitched = await scored([...strikeout, strike])
    expect(pitched.plays).has.length(1)
    expect(playsLost(await pitched.load())).deep.equals({
      atBats: 2,
      innings: 1
    })
  })

  it('counts two half-innings as one inning, and into the 2nd as two', async function () {
    const first = await scored([...half, ...half])
    expect(first.plays).has.length(5)
    expect(playsLost(await first.load())).deep.equals({ atBats: 6, innings: 1 })
    const second = await scored([...half, ...half, strike])
    expect(playsLost(await second.load())).deep.equals({
      atBats: 7,
      innings: 2
    })
  })

  it('counts no at-bat for a record of lineup changes or game flow only', function () {
    const lineupOnly = {
      about: { atBatIndex: 3, inning: 2 },
      teamStation: {
        version: 2,
        setupBefore: setupOf(game()),
        actions: [roster]
      }
    }
    const flowOnly = {
      about: { atBatIndex: 3, inning: 2 },
      teamStation: {
        version: 2,
        setupBefore: setupOf(game()),
        actions: [{ type: 'gameFlow', kind: 'closePlay' }]
      }
    }
    expect(playsLost({ plays: [], currentPlay: lineupOnly })).deep.equals({
      atBats: 0,
      innings: 0
    })
    expect(playsLost({ plays: [], currentPlay: flowOnly })).deep.equals({
      atBats: 0,
      innings: 0
    })
  })

  it("leaves out the game's final entry, and counts an at-bat scored elsewhere by its events", function () {
    const plays = [
      { about: { atBatIndex: 0, inning: 1 } },
      { about: { atBatIndex: FINAL_INDEX, inning: 1 } }
    ]
    expect(
      playsLost({
        plays,
        currentPlay: { about: { atBatIndex: 1, inning: 1 }, playEvents: [{}] }
      })
    ).deep.equals({ atBats: 2, innings: 1 })
    expect(
      playsLost({
        plays,
        currentPlay: { about: { atBatIndex: 1, inning: 1 }, playEvents: [] }
      })
    ).deep.equals({ atBats: 1, innings: 1 })
    expect(playsLost({ plays: [{}], currentPlay: 'none' })).deep.equals({
      atBats: 1,
      innings: 0
    })
  })

  it('counts an at-bat an undo reopened once, though its row is kept', async function () {
    // A strikeout, the next batter's first pitch, then that pitch undone:
    // the strikeout is the at-bat in progress again, its row still stored.
    const store = new Store()
    const session = await ScoringSession.open(store, 'g1', context)
    for (const action of [roster, ...strikeout, strike])
      expect(session.apply(action).problems).deep.equals([])
    await session.flush()
    session.undo()
    session.undo()
    await session.flush()
    const stored = await store.load()
    expect(stored.plays.map(play => play.about.atBatIndex)).deep.equals([0])
    expect(stored.currentPlay?.about.atBatIndex).equals(0)
    expect(playsLost(stored)).deep.equals({ atBats: 1, innings: 1 })
  })

  it('says a swap resets a game with anything but its lineups, at-bats lost or not', async function () {
    expect(resetsPlays(await (await scored([])).load())).equals(false)
    expect(
      resetsPlays(await (await scored([{ type: 'pitch', call: 'B' }])).load())
    ).equals(true)
    const override = await scored([
      { type: 'gameFlow', kind: 'override', balls: 1 }
    ])
    const stored = await override.load()
    expect(playsLost(stored)).deep.equals({ atBats: 0, innings: 0 })
    expect(resetsPlays(stored)).equals(true)
    // A game ended with no at-bat stores only its final entry.
    const final = {
      plays: [{ about: { atBatIndex: FINAL_INDEX, inning: 1 } }],
      currentPlay: null
    }
    expect(playsLost(final)).deep.equals({ atBats: 0, innings: 0 })
    expect(resetsPlays(final)).equals(true)
    expect(
      resetsPlays({ plays: [], currentPlay: { playEvents: [{}] } })
    ).equals(true)
    expect(resetsPlays({ plays: [], currentPlay: { playEvents: [] } })).equals(
      false
    )
    expect(resetsPlays({ plays: [], currentPlay: 'none' })).equals(false)
    expect(resetWarning({ atBats: 0, innings: 0 })).equals(
      'Resets all game plays.'
    )
    expect(resetWarning({ atBats: 2, innings: 1 })).equals(
      'Resets all game plays: 2 at-bats in 1 inning will be lost.'
    )
  })

  it('says it in the singular for one', function () {
    expect(playsLostText({ atBats: 1, innings: 1 })).equals(
      '1 at-bat in 1 inning'
    )
    expect(playsLostText({ atBats: 5, innings: 2 })).equals(
      '5 at-bats in 2 innings'
    )
  })
})
