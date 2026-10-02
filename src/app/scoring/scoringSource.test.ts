import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGameDetail,
  asRosterEntry,
  type DefaultLineup,
  type LineupPerson,
  type RosterEntry,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { ScoringSession } from '../../common/scoring/session'
import { type Position, POSITIONS } from '../../common/scoring/state'
import { startingSetup, teamsOf } from './developmentSession'
import { memoryStore, ServerScoringSource } from './scoringSource'

const game = asGameDetail({
  id: 'g1',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: true,
  videos: []
})
const roster = (first: number): RosterEntry[] =>
  Array.from({ length: 9 }, (_, i) =>
    asRosterEntry({
      userId: first + i,
      shortName: `Player ${first + i}`,
      jersey: String(i + 1),
      positions: [],
      isPlayer: true,
      role: 'member'
    })
  )
const away = roster(101)
const home = roster(201)
const person = (userId: number): LineupPerson => ({
  userId,
  name: `Player ${userId}`,
  jersey: ''
})
/** The visitors' default: the roster backwards, 101 pitching. */
const reversed: DefaultLineup = {
  lineup: {
    batters: [109, 108, 107, 106, 105, 104, 103, 102, 101].map(person),
    defense: {
      ...(Object.fromEntries(
        POSITIONS.map(position => [position, null])
      ) as Record<Position, LineupPerson | null>),
      P: person(101)
    }
  },
  fromGameId: 'g0',
  setAt: '2026-09-28T12:00:00.000Z'
}
const none: DefaultLineup = { lineup: null, fromGameId: null, setAt: null }

function client(
  defaults: (teamId: string) => Promise<DefaultLineup>,
  store = memoryStore()
): { client: TeamStationClient; asked: string[] } {
  const made = new TeamStationClient({ baseUrl: '/api/v1' })
  const asked: string[] = []
  made.defaultLineup = async teamId => {
    asked.push(teamId)
    return await defaults(teamId)
  }
  made.gameEvents = async gameId => await store.load(gameId)
  made.saveGameEvents = async (gameId, change) =>
    await store.save(gameId, change)
  return { client: made, asked }
}
const order = (session: ScoringSession, side: 'away' | 'home'): unknown[] =>
  session.state.liveData.boxscore.teams[side].battingOrder.map(
    id => session.state.gameData.players[id].userId
  )

describe('the server scoring source with default lineups (U12)', function () {
  it('opens a new game from each team’s default', async function () {
    const { client: fake, asked } = client(async teamId =>
      teamId === 'away' ? reversed : none
    )
    const session = await new ServerScoringSource(fake).open(game, away, home)
    expect(asked.sort()).deep.equals(['away', 'home'])
    expect(order(session, 'away')).deep.equals([
      109, 108, 107, 106, 105, 104, 103, 102, 101
    ])
    expect(order(session, 'home')).deep.equals([
      201, 202, 203, 204, 205, 206, 207, 208, 209
    ])
    const pitcher = session.state.liveData.boxscore.teams.away.defense.P
    expect(session.state.gameData.players[pitcher!].userId).equals(101)
  })

  it('starts a side from its roster when its default fails to load', async function () {
    const { client: fake } = client(async teamId => {
      if (teamId === 'away') throw new HttpError('internal', 'down')
      return none
    })
    const session = await new ServerScoringSource(fake).open(game, away, home)
    expect(order(session, 'away')).deep.equals([
      101, 102, 103, 104, 105, 106, 107, 108, 109
    ])
  })

  it('rebuilds a game that has records from them, whatever the default', async function () {
    const store = memoryStore()
    const first = await ScoringSession.open(store, 'g1', {
      gamePk: 'g1',
      teams: teamsOf(game),
      setup: startingSetup(game, away, home)
    })
    expect(first.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    await first.flush()
    const { client: fake } = client(async () => reversed, store)
    const session = await new ServerScoringSource(fake).open(game, away, home)
    expect(order(session, 'away')).deep.equals([
      101, 102, 103, 104, 105, 106, 107, 108, 109
    ])
    expect(session.state.liveData.linescore.balls).equals(1)
  })
})
