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
import { deviceStorage } from '../platform/deviceStorage'
import { startingSetup, teamsOf } from './developmentSession'
import {
  DevelopmentScoringSource,
  memoryStore,
  ServerScoringSource
} from './scoringSource'
import { ServerClock } from './serverClock'

const game = asGameDetail({
  nonMemberView: false,
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
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
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
  made.game = async () => game
  made.roster = async id => (id === game.awayTeamId ? away : home)
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
  it('reconciles the resumed lineup after an unfinished play without writing it on read', async () => {
    const store = memoryStore()
    const first = await ScoringSession.open(store, game.id, {
      gamePk: game.id,
      teams: teamsOf(game),
      setup: startingSetup(game, away, home)
    })
    expect(
      first.apply({ type: 'ballInPlay', contact: 'swing', fielder: 206 })
        .problems
    ).deep.equals([])
    await first.flush()
    const saved = JSON.stringify(store.games.get(game.id))
    const { client: fake } = client(async () => none, store)
    const current = { ...game, unrostered: { away: [109], home: [] } }
    const opened = await new ServerScoringSource(fake).open(current, away, home)
    const resumed = opened.resumable()
    expect(resumed.state.pending).equals(null)
    expect(resumed.state.liveData.boxscore.teams.away.players).not.includes(109)
    expect(opened.pending).equals(0)
    await opened.flush()
    expect(JSON.stringify(store.games.get(game.id))).equals(saved)
    expect(opened.sync(resumed.actions)).deep.equals([])
    expect(opened.undo().problems[0].message).equals('Nothing to undo')
  })

  it('reconciles saved options on read without writing, retains placements and keeps Undo on scoring actions', async () => {
    const store = memoryStore()
    const first = await ScoringSession.open(store, game.id, {
      gamePk: game.id,
      teams: teamsOf(game),
      setup: startingSetup(game, away.slice(0, 3), home)
    })
    first.apply({ type: 'pitch', call: 'B' })
    await first.flush()
    const saved = JSON.stringify(store.games.get(game.id))
    const { client: fake } = client(async () => none, store)
    const guest = asRosterEntry({
      ...away[0],
      userId: 901,
      shortName: 'Babe Ruth'
    })
    const current = {
      ...game,
      unrostered: { away: [102], home: [] },
      guestPlayers: { away: [guest], home: [] }
    }
    fake.game = async () => current
    const opened = await new ServerScoringSource(fake).open(current, away, home)
    expect(opened.state.liveData.boxscore.teams.away.players).deep.equals([
      101, 103, 104, 105, 106, 107, 108, 109, 901
    ])
    expect(order(opened, 'away')).deep.equals([101, 103])
    expect(opened.state.liveData.boxscore.teams.away.defense.C).equals(null)
    expect(opened.pending).equals(0)
    await opened.flush()
    expect(JSON.stringify(store.games.get(game.id))).equals(saved)
    expect(await opened.reload()).equals(false)
    expect(opened.undo().problems).deep.equals([])
    expect(opened.state.liveData.linescore.balls).equals(0)
    expect(opened.state.liveData.boxscore.teams.away.players).not.includes(102)
    expect(opened.undo().problems[0].message).equals('Nothing to undo')
    await opened.flush()
    const again = await new ServerScoringSource(fake).open(current, away, home)
    expect(again.state.liveData.boxscore.teams.away.players).includes(901)
  })

  it('keeps actual rosters without manufactured players on ordinary scoring entry', async function () {
    const { client: fake } = client(async () => none)
    for (const count of [0, 8]) {
      const session = await new ServerScoringSource(fake).open(
        game,
        away,
        home.slice(0, count)
      )
      expect(session.state.liveData.boxscore.teams.home.players).has.length(
        count
      )
      expect(
        Object.values(session.state.gameData.players).some(
          player => player.local
        )
      ).equals(false)
      expect(
        session.apply({ type: 'pitch', call: 'B' }).problems[0].message
      ).includes('Missing defensive positions')
    }
    const session = await new ServerScoringSource(fake).open(game, [], home)
    expect(session.state.liveData.linescore.offense.batter).equals(null)
    expect(
      session.apply({ type: 'pitch', call: 'B' }).problems[0].message
    ).equals('No players in lineup')
  })
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
  it('routes server tag operations and retains development tags through reopening', async () => {
    const serverClient = new TeamStationClient({ baseUrl: '/api/v1' })
    serverClient.tagChoices = async () => ({
      recent: ['great pitch'],
      popular: []
    })
    serverClient.saveEventTag = async (_gameId, targetId, tag) => ({
      targetId,
      tag,
      revision: '1'
    })
    const server = new ServerScoringSource(serverClient)
    expect((await server.tagChoices()).recent).deep.equals(['great pitch'])
    const source = new DevelopmentScoringSource()
    const session = await source.open(game, away, home)
    session.apply({ type: 'pitch', call: 'B' })
    await session.flush()
    const target = session.eventTargets[0]
    expect(await server.saveTag(session, target.id, 'great pitch')).deep.equals(
      { targetId: target.id, tag: 'great pitch', revision: '1' }
    )
    const saved = await source.saveTag(
      session,
      target.id,
      'Great Pitch',
      'actor'
    )
    session.setEventTag(saved.targetId, saved.tag)
    expect((await source.tagChoices('actor')).recent).deep.equals([
      'great pitch'
    ])
    const reopened = await source.open(game, away, home)
    expect(reopened.eventTargets[0].tag).equals('great pitch')
    reopened.undo()
    await reopened.flush()
    expect((await source.tagChoices('actor')).popular).deep.equals([])
    expect((await source.tagChoices('actor')).recent).deep.equals([
      'great pitch'
    ])
    const empty = await source.open(game, away, home)
    await source.saveTag(empty, 'missing_target', null, 'actor')
  })
})

describe('the server scoring source’s clock (U43)', function () {
  /** Both sides' own rosters as their defaults: a game ready to score. */
  const ready = async (teamId: string): Promise<DefaultLineup> => {
    const rows = teamId === 'away' ? away : home
    return {
      lineup: {
        batters: rows.map(row => person(row.userId)),
        defense: Object.fromEntries(
          POSITIONS.map((position, i) => [position, person(rows[i].userId)])
        ) as Record<Position, LineupPerson | null>
      },
      fromGameId: 'g0',
      setAt: '2026-09-28T12:00:00.000Z'
    }
  }

  it('stamps every action with its clock, and keeps that clock while asked', async function () {
    const { client: fake } = client(ready)
    const timers = new Set<unknown>()
    const clock = new ServerClock(
      async () => Date.parse('2026-09-28T18:00:30.000Z'),
      deviceStorage,
      {
        local: () => Date.parse('2026-09-28T18:00:00.000Z'),
        setInterval: () => {
          const timer = {}
          timers.add(timer)
          return timer
        },
        clearInterval: timer => timers.delete(timer)
      }
    )
    const source = new ServerScoringSource(fake, clock)
    const stop = source.keepTime()
    expect(timers.size).equals(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(clock.offset).equals(30_000)
    const session = await source.open(game, away, home)
    expect(session.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    expect(
      (session.picture().current?.teamStation as { actionTimes?: string[] })
        .actionTimes
    ).deep.equals(['2026-09-28T18:00:30.000Z'])
    stop()
    expect(timers.size).equals(0)
  })

  it('reads the server’s clock through its client by default', async function () {
    const { client: fake } = client(ready)
    fake.serverTime = async () => Date.now() + 12_000
    const source = new ServerScoringSource(fake)
    await source.clock.measure()
    expect(source.clock.offset).within(11_000, 13_000)
  })
})
