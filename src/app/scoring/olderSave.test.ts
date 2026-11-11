import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGameDetail, asRosterEntry, type RosterEntry } from '../../common/api'
import type { GumboPlay } from '../../common/gumboPlay'
import type { ScoringAction } from '../../common/scoring/actions'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { userIdOfGumbo } from '../../common/userId'
import { startingSetup, teamsOf } from './developmentSession'
import { overrideActions, overrideDraftOf } from './overrideModel'
import { memoryStore, olderSaveFoldsAlike } from './scoringSource'

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

/** The game as a build that does not know `keepAtBat` reads it. */
const asOlderBuildReads = (stored: StoredGame): StoredGame =>
  JSON.parse(
    JSON.stringify(stored).replace(/,"keepAtBat":true/g, '')
  ) as StoredGame

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
 * A phone on a build from before `keepAtBat`: it reads the server's game as
 * that build does, scores a strikeout, and queues the save, which it holds
 * on its copy of the game as the server sent it. Answers that copy and the
 * save it queued.
 */
async function olderBuildScores(
  served: StoredGame
): Promise<{ held: StoredGame; queued: SaveChange }> {
  const phone = memoryStore(new Map([[game.id, copied(served)]]))
  let queued: SaveChange | undefined
  const older = await ScoringSession.open(
    {
      load: async () => asOlderBuildReads(served),
      save: async (gameId, change) => {
        queued = change
        return await phone.save(gameId, change)
      }
    },
    game.id,
    context
  )
  applied(older, strikeout)
  await older.flush()
  return { held: await phone.load(game.id), queued: queued! }
}

/** What this build would have saved, scoring `actions` on the server's game. */
async function thisBuildSaves(
  served: StoredGame,
  actions: ScoringAction[]
): Promise<SaveChange> {
  let saved: SaveChange | undefined
  const store = memoryStore(new Map([[game.id, copied(served)]]))
  const current = await ScoringSession.open(
    {
      load: store.load,
      save: async (gameId, change) => {
        saved = change
        return await store.save(gameId, change)
      }
    },
    game.id,
    context
  )
  applied(current, actions)
  await current.flush()
  return saved!
}

const unread = async (): Promise<never> => {
  throw new Error('not read')
}

describe('a save of plays an older build queued', function () {
  it('is held where the game kept an at-bat at the end of a half: that build misplaced its plays', async function () {
    const server = await servedGame()
    const served = copied(server.games.get(game.id)!)
    const { held, queued } = await olderBuildScores(served)
    const expected = await thisBuildSaves(served, strikeout)
    // The older build writes its strikeout over the play at 5; this build
    // adds it at 6.
    expect(results(queued.plays).map(([index]) => index)).deep.equals([5])
    expect(results(expected.plays).map(([index]) => index)).deep.equals([6])
    expect(results(queued.plays)[0].slice(1)).deep.equals(
      results(expected.plays)[0].slice(1)
    )
    expect(
      await olderSaveFoldsAlike(null, {
        held: async () => held,
        server: async () => served
      })
    ).equals(false)
    expect(
      await olderSaveFoldsAlike(3, {
        held: async () => held,
        server: async () => served
      })
    ).equals(false)
  })

  it('is held where the server kept an at-bat after the phone read the game', async function () {
    const plain = memoryStore()
    const scorer = await ScoringSession.open(plain, game.id, context)
    applied(scorer, [...walk])
    await scorer.flush()
    const read = copied(plain.games.get(game.id)!)
    const kept = await servedGame()
    expect(
      await olderSaveFoldsAlike(null, {
        held: async () => read,
        server: async () => copied(kept.games.get(game.id)!)
      })
    ).equals(false)
  })

  it('goes as it was queued in any other game, where both builds fold every play alike', async function () {
    const server = memoryStore()
    const scorer = await ScoringSession.open(server, game.id, context)
    applied(scorer, [...walk, ...walk, ball])
    const second = scorer.state.liveData.linescore.offense.second!.id
    applied(scorer, [
      { type: 'baseRunning', kind: 'steal', runner: second, to: '3B' },
      { type: 'gameFlow', kind: 'endHalf' },
      ...strikeout
    ])
    await scorer.flush()
    const served = copied(server.games.get(game.id)!)
    const { held, queued } = await olderBuildScores(served)
    const expected = await thisBuildSaves(served, strikeout)
    expect(results(queued.plays)).deep.equals(results(expected.plays))
    expect(
      await olderSaveFoldsAlike(null, {
        held: async () => held,
        server: async () => served
      })
    ).equals(true)
    // With nothing on the phone, the server's game alone is judged.
    expect(
      await olderSaveFoldsAlike(null, {
        held: async () => undefined,
        server: async () => served
      })
    ).equals(true)
  })

  it('goes as it was queued from the current fold, unread', async function () {
    expect(
      await olderSaveFoldsAlike(5, { held: unread, server: unread })
    ).equals(true)
  })

  for (const variant of ['score', 'runner'])
    it(`permits a fold-4 queued save after an ordinary new-editor correction: ${variant}`, async function () {
      const store = memoryStore()
      const starting = copied(context)
      const scorer = await ScoringSession.open(store, game.id, starting)
      applied(scorer, [ball])
      const prepared = overrideActions(scorer.state, {
        ...overrideDraftOf(scorer.state),
        awayScore: 2,
        ...(variant === 'runner' ? { bases: [102, null, null] } : {})
      })
      if ('error' in prepared) throw new Error(prepared.error)
      expect(prepared.actions[0]).not.property('batterIndex')
      expect(prepared.actions[0]).not.property('clearPitcher')
      applied(scorer, prepared.actions)
      await scorer.flush()
      const stored = copied(store.games.get(game.id)!)
      expect(
        await olderSaveFoldsAlike(4, {
          held: async () => stored,
          server: async () => stored
        })
      ).equals(true)
    })

  it('holds older saves for a late-start score edit before assigning the pitcher', async function () {
    const store = memoryStore()
    const starting = copied(context)
    starting.setup.sides.home.defense.P = null
    const scorer = await ScoringSession.open(store, game.id, starting)
    const prepared = overrideActions(scorer.state, {
      ...overrideDraftOf(scorer.state),
      inning: 3,
      awayScore: 2
    })
    if ('error' in prepared) throw new Error(prepared.error)
    expect(copied(prepared.actions[0])).not.property('pitcher')
    expect(prepared.actions[0]).property('clearPitcher', true)
    applied(scorer, prepared.actions)
    expect(scorer.state.liveData.linescore.currentInning).equals(3)
    expect(scorer.state.liveData.linescore.teams.away.runs).equals(2)
    await scorer.flush()
    const stored = copied(store.games.get(game.id)!)
    expect(
      await olderSaveFoldsAlike(4, { held: async () => stored, server: unread })
    ).equals(false)
    expect(
      await olderSaveFoldsAlike(4, {
        held: async () => undefined,
        server: async () => stored
      })
    ).equals(false)
    expect(
      await olderSaveFoldsAlike(5, { held: unread, server: unread })
    ).equals(true)
  })

  it('holds pre-5 saves when either copy contains new override semantics, but permits old games', async function () {
    const store = memoryStore()
    const scorer = await ScoringSession.open(store, game.id, context)
    applied(scorer, [ball])
    await scorer.flush()
    const plain = copied(store.games.get(game.id)!)
    for (const action of [
      { type: 'gameFlow', kind: 'override', clearPitcher: true },
      { type: 'gameFlow', kind: 'override', batterIndex: 4 },
      { type: 'lineup', kind: 'roster', setup: {}, replaces: 1 }
    ]) {
      const changed = copied(plain)
      const record = changed.currentPlay as unknown as {
        teamStation: { actions: unknown[] }
      }
      record.teamStation.actions.push(action)
      expect(
        await olderSaveFoldsAlike(4, {
          held: async () => changed,
          server: unread
        })
      ).equals(false)
      expect(
        await olderSaveFoldsAlike(4, {
          held: async () => plain,
          server: async () => changed
        })
      ).equals(false)
      expect(
        await olderSaveFoldsAlike(5, { held: unread, server: unread })
      ).equals(true)
    }
    expect(
      await olderSaveFoldsAlike(4, {
        held: async () => plain,
        server: async () => plain
      })
    ).equals(true)
    const legacyRoster = copied(plain)
    const legacyRecord = legacyRoster.currentPlay as unknown as {
      teamStation: { actions: unknown[] }
    }
    legacyRecord.teamStation.actions.push({
      type: 'lineup',
      kind: 'roster',
      setup: {}
    })
    expect(
      await olderSaveFoldsAlike(4, {
        held: async () => legacyRoster,
        server: async () => legacyRoster
      })
    ).equals(true)
    const kept = await servedGame()
    expect(
      await olderSaveFoldsAlike(4, {
        held: async () => undefined,
        server: async () => copied(kept.games.get(game.id)!)
      })
    ).equals(true)
  })
  it('throws a server read that failed, for the queue to try again', async function () {
    const server = memoryStore()
    const scorer = await ScoringSession.open(server, game.id, context)
    applied(scorer, walk)
    await scorer.flush()
    const held = copied(server.games.get(game.id)!)
    let failure: unknown
    try {
      await olderSaveFoldsAlike(null, {
        held: async () => held,
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
