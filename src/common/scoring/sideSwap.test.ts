import { expect } from 'chai'
import { describe, it } from 'mocha'

import { game, TEAMS } from '../../test/scoringGames'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { LineupAction, ScoringAction } from './actions'
import { recordOf, replayPlays, type TeamStationRecord } from './gumbo'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from './session'
import { pregameRecord, swapRecordSides, swapSideLists } from './sideSwap'
import { type GameSetup, setupOf } from './state'

/** A server in memory, holding only what the session saves. */
class Store implements EventStore {
  plays: GumboPlay[] = []
  current: CurrentPlay | null = null

  async load(): Promise<StoredGame> {
    return { plays: this.plays, currentPlay: this.current }
  }

  async save(_gameId: string, change: SaveChange): Promise<StoredGame> {
    this.plays = [...this.plays, ...change.plays]
    if (change.currentPlay !== undefined) this.current = change.currentPlay
    return await this.load()
  }
}

const context = { gamePk: 'g1', teams: TEAMS, setup: setupOf(game()) }
const exchanged = (setup: GameSetup): GameSetup => ({
  ...setup,
  sides: { home: setup.sides.away, away: setup.sides.home }
})
/** The same game after the swap: the visitors at home, the hosts away. */
const swappedContext = {
  gamePk: 'g1',
  teams: { home: TEAMS.away, away: TEAMS.home },
  setup: exchanged(context.setup)
}

/** The at-bat a session leaves open after these actions. */
async function scored(actions: ScoringAction[]): Promise<CurrentPlay> {
  const store = new Store()
  const session = await ScoringSession.open(store, 'g1', context)
  for (const action of actions)
    expect(session.apply(action).problems, JSON.stringify(action)).deep.equals(
      []
    )
  await session.flush()
  expect(store.plays).deep.equals([])
  return store.current!
}

function roster(
  change: (setup: GameSetup) => void = () => undefined
): ScoringAction {
  const setup = setupOf(game())
  change(setup)
  return { type: 'lineup', kind: 'roster', setup, confirmed: ['away', 'home'] }
}
const leadoffsExchanged = roster(setup => {
  const [first, second, ...rest] = setup.sides.away.battingOrder
  setup.sides.away.battingOrder = [second, first, ...rest]
})
const bench: ScoringAction = {
  type: 'lineup',
  kind: 'addPlayer',
  side: 'home',
  player: 30,
  name: 'Bench Player',
  jersey: '30'
}
const substitute: ScoringAction = {
  type: 'lineup',
  kind: 'substitute',
  side: 'home',
  position: 'LF',
  player: 30,
  replaces: 16
}
const battingOrder: ScoringAction = {
  type: 'lineup',
  kind: 'battingOrder',
  side: 'away',
  order: [2, 1, 3, 4, 5, 6, 7, 8, 9]
}
const threeSaves = [roster(), leadoffsExchanged, roster(), bench, substitute]

/** The play with these actions after its own, as an older save could hold. */
function withActions(
  play: CurrentPlay,
  ...actions: ScoringAction[]
): CurrentPlay {
  const record = recordOf(play)!
  const changed = {
    ...play,
    teamStation: { ...record, actions: [...record.actions, ...actions] }
  }
  // The record still reads, so a refusal is the action's and no misreading.
  expect(recordOf(changed), JSON.stringify(actions)).not.equals(null)
  return changed
}

describe('swapping home and away', function () {
  describe('a game before its first play', function () {
    it('is one with no record, or a record of lineup changes only', async function () {
      expect(pregameRecord(null)).equals(true)
      expect(pregameRecord(undefined)).equals(true)
      expect(pregameRecord(await scored([roster()]))).equals(true)
      expect(pregameRecord(await scored(threeSaves))).equals(true)
      expect(
        pregameRecord(await scored([roster(), battingOrder, bench, substitute]))
      ).equals(true)
    })

    it('is not one with a pitch, a play, a runner or a manual state', async function () {
      const lineups = await scored([roster()])
      const begun: ScoringAction[] = [
        { type: 'pitch', call: 'B' },
        { type: 'ballInPlay', contact: 'swing' },
        { type: 'result', eventType: 'intent_walk' },
        { type: 'baseRunning', kind: 'steal', runner: 1, to: '2B' },
        { type: 'runnerMovement', runner: 1, to: '2B' },
        { type: 'batteryEvent', kind: 'wild_pitch' },
        { type: 'gameFlow', kind: 'placeRunner', runner: 9, base: '2B' },
        { type: 'gameFlow', kind: 'override', balls: 1 }
      ]
      for (const action of begun)
        expect(pregameRecord(withActions(lineups, action)), action.type).equals(
          false
        )
      expect(
        pregameRecord(await scored([roster(), { type: 'pitch', call: 'B' }]))
      ).equals(false)
    })

    it('is not one with pitch events, or an at-bat TeamStation did not score', async function () {
      const lineups = await scored([roster()])
      expect(pregameRecord({ ...lineups, playEvents: [{}] })).equals(false)
      const { teamStation, ...outside } = lineups as CurrentPlay & {
        teamStation?: unknown
      }
      expect(teamStation).not.equals(undefined)
      expect(pregameRecord(outside)).equals(false)
      expect(pregameRecord({ ...lineups, teamStation: 'garbled' })).equals(
        false
      )
    })
  })

  describe('the record', function () {
    it('moves every side to the other team and keeps the players', async function () {
      const record = recordOf(await scored([...threeSaves, battingOrder]))!
      const input = structuredClone(record)
      const swapped = swapRecordSides(record)
      expect(record).deep.equals(input)

      expect(swapped.setupBefore.sides).deep.equals({
        home: record.setupBefore.sides.away,
        away: record.setupBefore.sides.home
      })
      expect(swapped.setupBefore.players).equals(record.setupBefore.players)
      expect(swapped.setupBefore.tagOrder).equals(record.setupBefore.tagOrder)
      for (const key of ['version', 'detail', 'actionTimes'] as const)
        expect(swapped[key], key).deep.equals(record[key])

      const lineup = (action: ScoringAction): LineupAction =>
        action.type === 'lineup' ? action : expect.fail(action.type)
      const [first, second, , added, sub, order] = swapped.actions.map(lineup)
      expect(first.setup!.sides).deep.equals(
        exchanged(lineup(record.actions[0]).setup!).sides
      )
      expect(first.setup!.players).equals(
        lineup(record.actions[0]).setup!.players
      )
      expect(first.confirmed).deep.equals(['home', 'away'])
      expect(second.setup!.sides.home.battingOrder.slice(0, 2)).deep.equals([
        2, 1
      ])
      expect([added.side, sub.side, order.side]).deep.equals([
        'away',
        'away',
        'home'
      ])
      expect(sub.player).equals(30)
      expect(sub.replaces).equals(16)
    })

    it('maps confirmed and unseen sides to the other team', function () {
      const setup = setupOf(game())
      const record: TeamStationRecord = {
        version: 2,
        setupBefore: setup,
        actions: [
          {
            type: 'lineup',
            kind: 'roster',
            setup,
            confirmed: ['away'],
            unseen: ['home']
          },
          {
            type: 'lineup',
            kind: 'roster',
            setup,
            confirmed: ['away', 'home']
          },
          { type: 'pitch', call: 'B' }
        ]
      }
      const [one, two, pitch] = swapRecordSides(record).actions
      expect(one).deep.include({ confirmed: ['home'], unseen: ['away'] })
      expect(two).deep.include({ confirmed: ['home', 'away'] })
      expect(pitch).equals(record.actions[2])
    })

    it('comes back from two swaps unchanged', async function () {
      const record = recordOf(await scored(threeSaves))!
      expect(swapRecordSides(swapRecordSides(record))).deep.equals(record)
    })

    it('replays against the swapped teams, where the unswapped one cannot', async function () {
      const current = await scored(threeSaves)
      const swapped = {
        ...current,
        teamStation: swapRecordSides(recordOf(current)!)
      }
      const replayed = replayPlays(
        { plays: [], currentPlay: swapped },
        swappedContext
      )
      expect(replayed.problems).deep.equals([])
      const teams = replayed.state.liveData.boxscore.teams
      expect(teams.away.battingOrder[0]).equals(10)
      expect(teams.home.battingOrder.slice(0, 2)).deep.equals([1, 2])
      expect(teams.away.players).includes(30)
      expect(replayed.state.liveData.linescore.offense.batter?.id).equals(10)

      const unswapped = replayPlays(
        { plays: [], currentPlay: current },
        swappedContext
      )
      expect(unswapped.problems.map(problem => problem.message).join()).match(
        /invalid or duplicate lineup player/
      )
    })
  })

  describe('a side-keyed column', function () {
    it('exchanges its lists and keeps anything else it holds', function () {
      const guests = { home: [7], away: [], note: 'kept' }
      expect(swapSideLists(guests)).deep.equals({
        home: [],
        away: [7],
        note: 'kept'
      })
      expect(guests).deep.equals({ home: [7], away: [], note: 'kept' })
    })
  })
})
