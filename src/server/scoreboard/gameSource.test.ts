import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { mintUserId } from '../../common/mintUserId'
import type { ScoringAction } from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/apply'
import { freshGame, newSetup } from '../../common/scoring/lineup'
import { scoreboardOfGame } from '../../common/scoring/scoreboardOf'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type SessionContext
} from '../../common/scoring/session'
import {
  addGame,
  addPerson,
  dropPrefix,
  type Person,
  requireRedis,
  scratchDatabase,
  situationActions,
  testPrefix,
  testStore
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { postGamePlays, readPlays } from '../events/postPlays'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { eventRoutes } from '../routes/events'
import { gameRecord } from './gameRecord'
import {
  gameWrittenHook,
  scoreboardFromGame,
  writeGameScoreboard
} from './gameSource'
import type { ScoreboardClient, ScoreboardStore } from './scoreboardStore'

/**
 * The game's own scoring as a scoreboard source, on a scratch database and a
 * real Redis: the scored game read back and replayed, the write it makes, and
 * the hook the play post calls.
 */

const held = new Set<number>()
const minted = Array.from({ length: 18 }, () => {
  const made = mintUserId(id => held.has(id))
  held.add(made.userId)
  return made
})

describe('the game as a scoreboard source', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let client: ScoreboardClient
  let store: ScoreboardStore
  let home = ''
  let away = ''
  let runner: Person
  let stranger: Person
  let teams: SessionContext['teams']
  let setup: SessionContext['setup']
  const logged: string[] = []
  const log = (line: string): void => {
    logged.push(line)
  }

  const load = async (gameId: string): ReturnType<EventStore['load']> => {
    const game = await db
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    return {
      plays: (await readPlays(db, gameId)).map(row => row.gumbo as GumboPlay),
      currentPlay: game.currentPlay as CurrentPlay | null
    }
  }
  const body = (change: SaveChange): unknown => ({
    ...change,
    mode: 'live',
    source: { system: 'teamstation' }
  })
  /** Where a session writes: straight to the database, as the refold does. */
  const direct: EventStore = {
    load,
    save: async (gameId, change) => {
      await postGamePlays(db, gameId, asPostEventsBody(body(change)))
      return await load(gameId)
    }
  }

  async function score(
    gameId: string,
    actions: ScoringAction[],
    eventStore: EventStore = direct
  ): Promise<void> {
    const session = await ScoringSession.open(
      eventStore,
      gameId,
      { gamePk: gameId, teams, setup },
      { setTimer: () => null, clearTimer: () => undefined }
    )
    for (const action of actions) {
      expect(
        session.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
      await session.flush()
    }
  }

  before(async function () {
    await requireRedis()
    ;({ db, drop } = await scratchDatabase('scoreboard_source'))
    ;({ client, store } = await testStore(testPrefix()))
    const now = new Date()
    home = (
      await db
        .insertInto('teams')
        .values({ id: 'tea_home_src', name: 'Hawks' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    away = (
      await db
        .insertInto('teams')
        .values({ id: 'tea_away_src', name: 'Gulls' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    await db
      .insertInto('users')
      .values(
        minted.map((made, i) => ({
          id: made.userId,
          legacyId: made.legacyId,
          display_name: `Player ${i}`,
          created_at: now,
          updated_at: now
        }))
      )
      .execute()
    teams = {
      away: { id: away, name: 'Gulls', logoUrl: null },
      home: { id: home, name: 'Hawks', logoUrl: null }
    }
    setup = newSetup(teams, {
      away: minted.slice(0, 9).map((made, i) => ({
        userId: made.userId,
        shortName: `Away ${i + 1}`
      })),
      home: minted
        .slice(9)
        .map((made, i) => ({ userId: made.userId, shortName: `Home ${i + 1}` }))
    })
    runner = await addPerson(db, 'runner', { owns: home })
    stranger = await addPerson(db, 'stranger')
  })

  after(async function () {
    if (client?.isOpen) await client.close()
    await dropPrefix('ts-test')
    await drop?.()
  })

  it('reads the record: names, scores, start and status', async function () {
    const startAt = new Date('2026-09-28T18:00:00Z')
    const gameId = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt,
      homeScore: 3
    })
    expect(await gameRecord(db, gameId)).deep.equals({
      startAt: startAt.getTime(),
      status: 'scheduled',
      homeTeamId: home,
      awayTeamId: away,
      homeTeam: 'Hawks',
      awayTeam: 'Gulls',
      homeScore: 3,
      awayScore: null
    })
    expect(await gameRecord(db, 'gam_nothere')).equals(undefined)
  })

  it('replays a scored game into the same board as applying its actions', async function () {
    const gameId = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date()
    })
    const actions = situationActions(setup)
    await score(gameId, actions)

    let memory = freshGame(gameId, teams, setup)
    for (const action of actions) memory = applyAction(memory, action).state

    const source = await scoreboardFromGame(db, gameId, log)
    const row = await db
      .selectFrom('games')
      .select(['updated_at', 'start_at'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(source).deep.equals({
      state: scoreboardOfGame(memory),
      sourceVersion: new Date(row.updated_at).getTime() * 1000,
      startAt: new Date(row.start_at).getTime()
    })
    expect(source?.state).includes({ inning: 2, half: 'top', awayScore: 1 })
  })

  it('has nothing for a game with no plays, one it did not score, or one that does not replay', async function () {
    const empty = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date()
    })
    expect(await scoreboardFromGame(db, empty, log)).equals(undefined)
    expect(await scoreboardFromGame(db, 'gam_nothere', log)).equals(undefined)

    // Another service's plays carry no TeamStation record to replay.
    const imported = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date()
    })
    await db
      .updateTable('games')
      .set({
        currentPlay: JSON.stringify({ about: { atBatIndex: 0 } })
      })
      .where('id', '=', imported)
      .execute()
    expect(await scoreboardFromGame(db, imported, log)).equals(undefined)

    // A log that no longer replays: strike three before any strike.
    const broken = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date()
    })
    await score(broken, situationActions(setup).slice(0, 5))
    const stored = await load(broken)
    const record = (
      stored.plays[0] as unknown as {
        teamStation: { setupBefore: unknown }
      }
    ).teamStation
    await db
      .updateTable('games')
      .set({
        currentPlay: JSON.stringify({
          ...(stored.currentPlay ?? { about: { atBatIndex: 2 } }),
          teamStation: {
            version: 2,
            setupBefore: record.setupBefore,
            actions: [{ type: 'result', eventType: 'strikeout' }]
          }
        })
      })
      .where('id', '=', broken)
      .execute()
    logged.length = 0
    expect(await scoreboardFromGame(db, broken, log)).equals(undefined)
    expect(logged).has.length(1)
    expect(logged[0]).includes(broken).and.includes('does not replay')
  })

  it('writes the scored board to Redis, and logs rather than failing', async function () {
    const gameId = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date()
    })
    await score(gameId, situationActions(setup).slice(0, 3))
    const result = await writeGameScoreboard({ db, store, log }, gameId)
    expect(result?.kind).equals('written')
    const hash = await store.readScoreboard(gameId)
    expect(hash?.game?.state).includes({ inGame: true, awayScore: 0 })

    const empty = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date()
    })
    expect(await writeGameScoreboard({ db, store, log }, empty)).equals(
      undefined
    )

    logged.length = 0
    const gone = { ...store, isReady: () => false }
    expect(await writeGameScoreboard({ db, store: gone, log }, gameId)).equals(
      undefined
    )
    expect(logged).deep.equals([
      `scoreboard: game ${gameId} not written: The scoreboard is unavailable`
    ])
  })

  describe('after a play post', function () {
    let server: ReturnType<express.Express['listen']> | undefined
    let base = ''
    const called: string[] = []
    let throwing = false

    before(async function () {
      const hook = gameWrittenHook({ db, store, log })
      const app = express()
      app.use(jsonBody)
      app.use(withActor(db))
      app.use(
        '/api/v1',
        eventRoutes(db, {
          onGameWritten: gameId => {
            called.push(gameId)
            if (throwing) throw new Error('the hook fell over')
            hook(gameId)
          }
        })
      )
      app.use(errorHandler)
      server = app.listen(0, '127.0.0.1')
      await new Promise(resolve => server?.once('listening', resolve))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    })

    after(function () {
      server?.close()
    })

    const overHttp = (who: Person): EventStore => ({
      load,
      save: async (gameId, change) => {
        const answer = await fetch(`${base}/games/${gameId}/events`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${who.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(body(change))
        })
        if (!answer.ok) throw new Error(`HTTP ${answer.status}`)
        return await load(gameId)
      }
    })

    it('calls the hook once per post, after it commits, and the hook writes the game', async function () {
      const gameId = await addGame(db, {
        homeTeamId: home,
        awayTeamId: away,
        startAt: new Date()
      })
      called.length = 0
      await score(gameId, [{ type: 'pitch', call: 'B' }], overHttp(runner))
      expect(called).deep.equals([gameId])
      const deadline = Date.now() + 5000
      while ((await store.readScoreboard(gameId)) == null) {
        if (Date.now() > deadline) throw new Error('the hook never wrote')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect((await store.readScoreboard(gameId))?.game?.state).includes({
        balls: 1,
        strikes: 0
      })
    })

    it('does not call it for a refused post, and a hook that throws changes nothing', async function () {
      const gameId = await addGame(db, {
        homeTeamId: home,
        awayTeamId: away,
        startAt: new Date()
      })
      called.length = 0
      const refused = await fetch(`${base}/games/${gameId}/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${stranger.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ plays: [], mode: 'live' })
      })
      expect(refused.status).equals(404)
      expect(called).deep.equals([])

      throwing = true
      const errors: unknown[] = []
      const consoleError = console.error
      console.error = (...args: unknown[]) => errors.push(args)
      try {
        await score(gameId, [{ type: 'pitch', call: 'B' }], overHttp(runner))
      } finally {
        throwing = false
        console.error = consoleError
      }
      expect(called).deep.equals([gameId])
      expect(String(errors[0])).includes(`onGameWritten ${gameId}`)
      expect((await load(gameId)).currentPlay).not.equals(null)
    })
  })
})
