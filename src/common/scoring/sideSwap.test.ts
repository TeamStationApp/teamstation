import { expect } from 'chai'
import { describe, it } from 'mocha'

import { game, TEAMS } from '../../test/scoringGames'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { LineupAction, ScoringAction } from './actions'
import {
  recordOf,
  replayPlays,
  storedRecordOf,
  type TeamStationRecord
} from './gumbo'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from './session'
import { pregameRecord } from './sideSwap'
import { type GameSetup, setupOf } from './state'
import { withoutNames } from './storedNames'
import { recordByTeam, retargetRecord, setupByTeam } from './teamRecord'

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
  const record = (play as { teamStation?: { actions: unknown[] } }).teamStation!
  const changed = {
    ...play,
    teamStation: { ...record, actions: [...record.actions, ...actions] }
  }
  // The record still reads, so a refusal is the action's and no misreading.
  expect(storedRecordOf(changed), JSON.stringify(actions)).not.equals(null)
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
    it('names teams, so it reads by the sides the game gives them', async function () {
      const current = await scored([...threeSaves, battingOrder])
      const stored = (current as { teamStation?: Record<string, unknown> })
        .teamStation!
      expect(stored.version).equals(3)
      expect(Object.keys(stored.setupBefore as object)).not.includes('sides')

      const asOpened = recordOf(current, TEAMS)!
      const asSwapped = recordOf(current, swappedContext.teams)!
      expect(asSwapped.setupBefore.sides).deep.equals({
        home: asOpened.setupBefore.sides.away,
        away: asOpened.setupBefore.sides.home
      })
      expect(asSwapped.setupBefore.players).deep.equals(
        asOpened.setupBefore.players
      )
      const lineup = (action: ScoringAction): LineupAction =>
        action.type === 'lineup' ? action : expect.fail(action.type)
      const [first, second, , added, sub, order] = asSwapped.actions.map(lineup)
      expect(first.setup!.sides).deep.equals(
        exchanged(lineup(asOpened.actions[0]).setup!).sides
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

    it('maps confirmed and unseen teams to the sides they hold', function () {
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
          { type: 'pitch', call: 'B' }
        ]
      }
      const stored = recordByTeam(record, TEAMS)
      expect(stored.actions).deep.include({
        type: 'lineup',
        kind: 'roster',
        setup: setupByTeam(setup, TEAMS),
        confirmed: [TEAMS.away.id],
        unseen: [TEAMS.home.id]
      })
      const [one, pitch] = recordOf(
        { teamStation: stored },
        swappedContext.teams
      )!.actions
      expect(one).deep.include({ confirmed: ['home'], unseen: ['away'] })
      expect(pitch).deep.equals(record.actions[1])
    })

    it('writes back to what it read from', async function () {
      const current = await scored(threeSaves)
      const stored = (current as { teamStation?: unknown }).teamStation
      // A stored record names nobody; read, it names its players '', and
      // written again in its stored form it is the record it was.
      expect(
        JSON.parse(
          JSON.stringify(
            withoutNames(recordByTeam(recordOf(current, TEAMS)!, TEAMS))
          )
        )
      ).deep.equals(JSON.parse(JSON.stringify(stored)))
    })

    it('refuses a record naming a team that is on neither side', async function () {
      const current = await scored(threeSaves)
      expect(
        recordOf(current, { away: TEAMS.away, home: { id: 'elsewhere' } })
      ).equals(null)
      expect(storedRecordOf(current)).not.equals(null)
    })

    it('follows a team id that changed', async function () {
      const current = await scored(threeSaves)
      const stored = (current as { teamStation?: unknown }).teamStation
      const moved = retargetRecord(stored, TEAMS.home.id, 'tem_replacement')
      const teams = { away: TEAMS.away, home: { id: 'tem_replacement' } }
      const read = recordOf({ teamStation: moved }, teams)!.setupBefore
      expect(read.sides).deep.equals(
        recordOf(current, TEAMS)!.setupBefore.sides
      )
      expect(
        Object.values(read.players)
          .filter(player => player.id >= 10 && player.id < 20)
          .every(player => player.teamId === 'tem_replacement')
      ).equals(true)
      expect(JSON.stringify(moved)).not.includes(`"${TEAMS.home.id}"`)
      expect(retargetRecord('not a record', 'a', 'b')).equals('not a record')
    })

    it('replays the same after the swap, with no record rewritten', async function () {
      const current = await scored(threeSaves)
      const replayed = replayPlays(
        { plays: [], currentPlay: current },
        swappedContext
      )
      expect(replayed.problems).deep.equals([])
      const teams = replayed.state.liveData.boxscore.teams
      expect(teams.away.battingOrder[0]).equals(10)
      expect(teams.home.battingOrder.slice(0, 2)).deep.equals([1, 2])
      expect(teams.away.players).includes(30)
      expect(replayed.state.liveData.linescore.offense.batter?.id).equals(10)
    })
  })
})
