import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGameDetail,
  asRosterEntry,
  type LineupPerson,
  type RosterEntry
} from '../../common/api'
import type { GumboPlay } from '../../common/gumboPlay'
import type { ScoringAction } from '../../common/scoring/actions'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type SessionLog,
  type StoredGame
} from '../../common/scoring/session'
import { type Position, POSITIONS } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import {
  type DefaultLineups,
  startingSetup,
  teamsOf
} from './developmentSession'
import { type GameReads, memoryStore, rebuildGameEvents } from './scoringSource'

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
      userId: userIdOfGumbo(first + i),
      gumboId: first + i,
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
const context = {
  gamePk: game.id,
  teams: teamsOf(game),
  setup: startingSetup(game, away, home)
}

const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }
const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const walk = [ball, ball, ball, ball, close]
const strikeout = [strike, strike, strike, close]

const copied = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** What tells one fold of a play from another: its place, its half, its batter and its result. */
const results = (
  plays: GumboPlay[]
): Array<[number, string, number, string, number]> =>
  plays
    .map((play): [number, string, number, string, number] => [
      play.about.atBatIndex,
      play.about.halfInning ?? '',
      Number(play.matchup?.batter?.id ?? 0),
      play.result.eventType ?? '',
      play.result.awayScore ?? 0
    ])
    .sort((a, b) => a[0] - b[0])

function applied(session: ScoringSession, actions: ScoringAction[]): void {
  for (const action of actions)
    expect(session.apply(action).problems, JSON.stringify(action)).deep.equals(
      []
    )
}

/**
 * The server's copy of a game this build scored: two walks, a ball, a steal
 * of third and of home, and the half ended with that at-bat kept, then the
 * other side struck out.
 */
async function servedGame(): Promise<
  EventStore & { games: Map<string, StoredGame> }
> {
  const server = memoryStore()
  const scorer = await ScoringSession.open(server, game.id, context)
  applied(scorer, [...walk, ...walk, ball])
  const second = scorer.state.liveData.linescore.offense.second!.id
  applied(scorer, [
    { type: 'baseRunning', kind: 'steal', runner: second, to: '3B' },
    { type: 'baseRunning', kind: 'steal', runner: second, to: 'home' },
    { type: 'gameFlow', kind: 'endHalf', keepAtBat: true },
    ...strikeout,
    ...strikeout,
    ...strikeout
  ])
  await scorer.flush()
  return server
}

/**
 * A phone on this build scoring `actions` on the server's game: the save it
 * queues, with its whole log beside it.
 */
async function phoneQueues(
  served: StoredGame,
  actions: ScoringAction[],
  time?: string
): Promise<SaveChange> {
  let queued: SaveChange | undefined
  const store = memoryStore(new Map([[game.id, copied(served)]]))
  const phone = await ScoringSession.open(
    {
      load: store.load,
      save: async (gameId, change) => {
        queued = change
        return await store.save(gameId, change)
      }
    },
    game.id,
    context
  )
  for (const action of actions)
    expect(
      phone.apply(action, time == null ? {} : { time }).problems,
      JSON.stringify(action)
    ).deep.equals([])
  await phone.flush()
  return copied(queued!)
}

function reads(
  served: StoredGame,
  rosters: Record<string, RosterEntry[]> = { away, home }
): GameReads {
  return {
    game: async () => game,
    roster: async teamId => rosters[teamId],
    defaults: async () => ({}),
    server: async () => served
  }
}

describe('rebuilding a save a build queued from the log it kept', function () {
  it('plays the log on the server’s plays and folds the game as this build does', async function () {
    const server = await servedGame()
    const served = copied(server.games.get(game.id)!)
    const queued = await phoneQueues(
      served,
      strikeout,
      '2026-11-09T18:00:00.000Z'
    )
    const log: SessionLog = queued.log!
    expect(log.actions.length).greaterThan(strikeout.length)
    const rebuilt = await rebuildGameEvents(game.id, log, reads(served))
    expect(rebuilt).not.equals(null)
    expect(rebuilt!.scoringBase).deep.equals(served.scoringMutation ?? null)
    expect(rebuilt!.scoringMutation).not.equals(undefined)
    expect(rebuilt!.scoringHistory).deep.equals(rebuilt!.plays)
    const plays = results(rebuilt!.plays)
    // The at-bat the half kept stays at 2, and the strikeout goes at 6.
    expect(plays.map(([index]) => index)).deep.equals([0, 1, 2, 3, 4, 5, 6])
    expect(plays[2]).deep.include.members([2, 'stolen_base_home'])
    expect(plays[6].slice(1)).deep.equals(results(queued.plays)[0].slice(1))
    expect(rebuilt!.remove).deep.equals([])
    // Each action keeps the time the log has for it.
    expect(JSON.stringify(rebuilt!.plays.at(-1))).includes(
      '2026-11-09T18:00:00.000Z'
    )
    // Stored form, with the names kept beside it.
    expect(rebuilt!.names).not.equals(undefined)
  })

  it('answers the server’s game again when the log adds nothing to it', async function () {
    const server = await servedGame()
    const served = copied(server.games.get(game.id)!)
    const queued = await phoneQueues(served, strikeout)
    // The save landed: the server holds what the log does.
    const landed = memoryStore(new Map([[game.id, copied(served)]]))
    await landed.save(game.id, queued)
    const now = copied(landed.games.get(game.id)!)
    const rebuilt = await rebuildGameEvents(game.id, queued.log!, reads(now))
    expect(results(rebuilt!.plays)).deep.equals(results(now.plays))
    expect(rebuilt!.scoringBase).deep.equals(now.scoringMutation ?? null)
    expect(rebuilt!.scoringMutation).equals(undefined)
  })

  it('starts a game the server holds nothing of from the teams’ defaults, as the scorer’s session did', async function () {
    const person = (gumboId: number): LineupPerson => ({
      gumboId,
      name: `Player ${gumboId}`,
      jersey: ''
    })
    // The visitors' default: the roster backwards, 101 pitching.
    const defaults: DefaultLineups = {
      away: {
        batters: [109, 108, 107, 106, 105, 104, 103, 102, 101].map(person),
        defense: {
          ...(Object.fromEntries(
            POSITIONS.map(position => [position, null])
          ) as Record<Position, LineupPerson | null>),
          P: person(101)
        }
      }
    }
    let queued: SaveChange | undefined
    const phone = await ScoringSession.open(
      {
        load: async () => ({ plays: [], currentPlay: null }),
        save: async (_gameId, change) => {
          queued = change
          return { plays: change.plays, currentPlay: null }
        }
      },
      game.id,
      {
        gamePk: game.id,
        teams: teamsOf(game),
        setup: startingSetup(game, away, home, defaults)
      }
    )
    applied(phone, walk)
    await phone.flush()
    const nothing: StoredGame = { plays: [], currentPlay: null }
    const rebuilt = await rebuildGameEvents(game.id, queued!.log!, {
      ...reads(nothing),
      defaults: async () => defaults
    })
    expect(rebuilt).not.equals(null)
    const [walked] = results(rebuilt!.plays)
    expect(walked).deep.equals([0, 'top', 109, 'walk', 0])
    expect(walked).deep.equals(results(queued!.plays)[0])
  })

  it('rebuilds nothing when the server’s log is not where the kept one began', async function () {
    const server = await servedGame()
    const read = copied(server.games.get(game.id)!)
    const queued = await phoneQueues(read, strikeout)
    // Another scorer saved a pitch first.
    const other = await ScoringSession.open(server, game.id, context)
    applied(other, [ball])
    await other.flush()
    const served = copied(server.games.get(game.id)!)
    expect(await rebuildGameEvents(game.id, queued.log!, reads(served))).equals(
      null
    )
    // A log shorter than the server's began somewhere else too.
    expect(
      await rebuildGameEvents(
        game.id,
        { actions: [ball], times: [null] },
        reads(served)
      )
    ).equals(null)
  })

  it('rebuilds nothing from a log with an action it cannot read, or that the game refuses', async function () {
    const server = await servedGame()
    const served = copied(server.games.get(game.id)!)
    const queued = await phoneQueues(served, strikeout)
    const log = queued.log!
    // As the phone's file read it back: what a newer build could not read.
    const unread: unknown = { type: 'swing' }
    expect(
      await rebuildGameEvents(
        game.id,
        {
          actions: [...log.actions, unread as ScoringAction],
          times: []
        },
        reads(served)
      )
    ).equals(null)
    // A runner who is not on base cannot steal.
    expect(
      await rebuildGameEvents(
        game.id,
        {
          actions: [
            ...log.actions,
            { type: 'baseRunning', kind: 'steal', runner: 999, to: '2B' }
          ],
          times: []
        },
        reads(served)
      )
    ).equals(null)
  })

  it('rebuilds nothing without the game or a roster to read', async function () {
    const server = await servedGame()
    const served = copied(server.games.get(game.id)!)
    const queued = await phoneQueues(served, strikeout)
    expect(
      await rebuildGameEvents(game.id, queued.log!, reads(served, { away }))
    ).equals(null)
    expect(
      await rebuildGameEvents(game.id, queued.log!, {
        ...reads(served),
        game: async () => undefined
      })
    ).equals(null)
  })

  it('throws a server read that failed, for the queue to try again', async function () {
    const server = await servedGame()
    const served = copied(server.games.get(game.id)!)
    const queued = await phoneQueues(served, strikeout)
    let failure: unknown
    try {
      await rebuildGameEvents(game.id, queued.log!, {
        ...reads(served),
        server: async () => {
          throw new Error('offline')
        }
      })
    } catch (error) {
      failure = error
    }
    expect(failure).property('message', 'offline')
  })
})
