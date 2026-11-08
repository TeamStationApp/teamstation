import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { asPostedEdits } from '../../common/api'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import type { ScoringMutation } from '../../common/scoring/scoringMutation'
import {
  type SaveChange,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import {
  addGame,
  addScorableTeams,
  scratchDatabase
} from '../../test/scoreboardKit'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { swapOrReset } from '../games/resetSwap'
import { atBatOf } from './atBatInProgress'
import { pregameFold } from './currentPlay'
import { gamePlaysDigest, postGamePlays, readPlays } from './postPlays'
import { storedLineupsDigest } from './teamLineups'

describe('scoring mutation ordering', function () {
  this.timeout(60000)
  let db: Kysely<Database>
  let drop: () => Promise<void>
  before(async () => {
    ;({ db, drop } = await scratchDatabase('scoring_mutation'))
  })
  after(async () => {
    await drop?.()
  })

  for (const reverse of [false, true]) {
    it(`keeps the later strike with ${reverse ? 'reversed' : 'ordinary'} delivery`, async () => {
      const context = await addScorableTeams(db, {
        home: 'Hawks',
        away: 'Gulls'
      })
      const gameId = await addGame(db, {
        homeTeamId: context.teams.home.id,
        awayTeamId: context.teams.away.id,
        startAt: new Date()
      })
      const changes: SaveChange[] = []
      for (const call of ['B', 'C'] as const) {
        const session = await ScoringSession.open(
          {
            load: async () => ({ plays: [], currentPlay: null }),
            save: async (_id, change) => {
              changes.push(change)
              return {}
            }
          },
          gameId,
          { gamePk: gameId, ...context },
          {
            setTimer: () => null,
            clearTimer: () => undefined
          }
        )
        expect(session.apply({ type: 'pitch', call }).problems).deep.equals([])
        await session.flush()
      }
      const at = Date.now() - 1000
      const requests = changes.map((change, i) =>
        asPostEventsBody({
          ...change,
          mode: 'live',
          source: { system: 'teamstation' },
          scoringMutation: {
            at: at + i,
            id: `author-${i}`,
            revision: 0,
            frontier: 0
          }
        })
      )
      for (const i of reverse ? [1, 0] : [0, 1])
        await postGamePlays(db, gameId, requests[i])
      const game = await db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      expect((game.currentPlay as { count: unknown }).count).deep.equals({
        balls: 0,
        strikes: 1,
        outs: 0
      })
    })
  }
  async function sessions(): Promise<{
    open: () => Promise<ScoringSession>
    load: () => Promise<StoredGame>
    gameId: string
    requests: SaveChange[]
    hooks: { read?: () => Promise<void> }
  }> {
    const context = await addScorableTeams(db, { home: 'Owls', away: 'Jays' })
    const gameId = await addGame(db, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id,
      startAt: new Date()
    })
    const requests: SaveChange[] = []
    const hooks: { read?: () => Promise<void> } = {}
    const load = async (): Promise<StoredGame> => {
      await hooks.read?.()
      const game = await db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      const plays = (await readPlays(db, gameId)).map(
        row => row.gumbo as GumboPlay
      )
      const fold = await pregameFold(db, gameId, game, {
        plays,
        currentPlay: atBatOf(game, plays.length > 0) as CurrentPlay | null
      })
      return {
        plays,
        currentPlay: await fold(),
        ...(game.scoring_mutation == null
          ? {}
          : {
              scoringMutation: game.scoring_mutation as ScoringMutation
            }),
        lineupsDigest: await storedLineupsDigest(db, game)
      }
    }
    let now = Date.now() - 5000
    const open = async (): Promise<ScoringSession> =>
      await ScoringSession.open(
        {
          load,
          save: async (_id, change) => {
            requests.push(change)
            return asPostedEdits(
              await postGamePlays(
                db,
                gameId,
                asPostEventsBody({
                  ...change,
                  mode: 'live',
                  source: { system: 'teamstation' }
                })
              )
            )
          }
        },
        gameId,
        { gamePk: gameId, ...context },
        {
          now: () => new Date(++now),
          setTimer: () => null,
          clearTimer: () => undefined
        }
      )
    return { open, load, gameId, requests, hooks }
  }
  for (const reverse of [false, true])
    it(`reconciles both sessions in ${reverse ? 'reverse' : 'ordinary'} order`, async () => {
      const { open, load } = await sessions()
      const a = await open()
      const b = await open()
      a.apply({ type: 'pitch', call: 'B' })
      b.apply({ type: 'pitch', call: 'C' })
      for (const session of reverse ? [b, a] : [a, b]) await session.flush()
      expect((await load()).currentPlay?.count).deep.equals({
        balls: 0,
        strikes: 1,
        outs: 0
      })
      await a.reload()
      await b.reload()
      expect(a.state.liveData.plays.currentPlay?.count).deep.equals({
        balls: 0,
        strikes: 1,
        outs: 0
      })
      expect(b.state.liveData.plays.currentPlay?.count).deep.equals({
        balls: 0,
        strikes: 1,
        outs: 0
      })
    })
  it('keeps a newer empty-game undo over an older scored pitch', async () => {
    const { open, load } = await sessions()
    const a = await open()
    a.apply({ type: 'pitch', call: 'B' })
    await a.flush()
    const b = await open()
    b.apply({ type: 'pitch', call: 'C' })
    a.undo()
    await b.flush()
    await a.flush()
    const stored = await load()
    expect(stored.plays).has.length(0)
    expect(stored.currentPlay?.count).deep.equals({
      balls: 0,
      strikes: 0,
      outs: 0
    })
    expect((await open()).state.liveData.plays.currentPlay?.count).deep.equals({
      balls: 0,
      strikes: 0,
      outs: 0
    })
  })

  it('retries identically without rewriting and refuses a changed identity body', async () => {
    const { open, gameId, requests } = await sessions()
    const a = await open()
    a.apply({ type: 'pitch', call: 'B' })
    await a.flush()
    const body = asPostEventsBody({
      ...requests[0],
      mode: 'live',
      source: { system: 'teamstation' }
    })
    const before = await db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    await postGamePlays(db, gameId, body)
    expect(
      await db
        .selectFrom('games')
        .selectAll()
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
    ).deep.equals(before)
    let rejected = false
    try {
      await postGamePlays(db, gameId, { ...body, remove: [5] })
    } catch (error) {
      rejected = true
      expect(String(error)).contains('identity was reused')
    }
    expect(rejected).equals(true)
  })
  it('refuses future clocks and malformed deletion frontiers without changing the game', async () => {
    const { open, gameId, requests, load } = await sessions()
    const a = await open()
    a.apply({ type: 'pitch', call: 'B' })
    await a.flush()
    const original = requests[0]
    for (const mutation of [
      { ...original.scoringMutation!, at: Date.now() + 60000 },
      { ...original.scoringMutation!, at: Date.now(), frontier: 10 }
    ]) {
      let rejected = false
      try {
        await postGamePlays(
          db,
          gameId,
          asPostEventsBody({
            ...original,
            mode: 'live',
            source: { system: 'teamstation' },
            scoringMutation: mutation
          })
        )
      } catch {
        rejected = true
      }
      expect(rejected).equals(true)
    }
    expect((await load()).currentPlay?.count).deep.equals({
      balls: 1,
      strikes: 0,
      outs: 0
    })
  })
  it('preserves the scoring barrier for internal projection writes', async () => {
    const { open, gameId, requests } = await sessions()
    const a = await open()
    a.apply({ type: 'pitch', call: 'B' })
    await a.flush()
    const {
      scoringMutation: _ignored,
      lineupsBase: _base,
      ...legacy
    } = requests[0]
    const body = asPostEventsBody({
      ...legacy,
      mode: 'live',
      source: { system: 'teamstation' }
    })
    const before = await db
      .selectFrom('games')
      .select('scoring_mutation')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    await postGamePlays(db, gameId, body)
    expect(
      await db
        .selectFrom('games')
        .select('scoring_mutation')
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
    ).deep.equals(before)
  })

  it('orders a legacy direct score by server arrival and rejects an older modern retry', async () => {
    const { open, gameId, requests, load } = await sessions()
    const a = await open()
    a.apply({ type: 'pitch', call: 'B' })
    await a.flush()
    a.apply({ type: 'pitch', call: 'C' })
    await a.flush()
    const {
      scoringMutation: _ignored,
      lineupsBase: _base,
      ...old
    } = requests[0]
    const arrived = Date.now()
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        ...old,
        mode: 'live',
        source: { system: 'teamstation' }
      }),
      undefined,
      undefined,
      { scoringAuthor: true }
    )
    expect((await load()).scoringMutation!.at).at.least(arrived)
    const reply = await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        ...requests[1],
        mode: 'live',
        source: { system: 'teamstation' }
      })
    )
    expect(reply.superseded).equals(true)
    expect((await load()).currentPlay?.count).deep.equals({
      balls: 1,
      strikes: 0,
      outs: 0
    })
  })
  const apply = (
    session: ScoringSession,
    action: Parameters<ScoringSession['apply']>[0]
  ): void => {
    expect(session.apply(action).problems).deep.equals([])
  }
  const strikeout = (session: ScoringSession): void => {
    for (let n = 0; n < 3; n++) apply(session, { type: 'pitch', call: 'C' })
    apply(session, { type: 'gameFlow', kind: 'closePlay' })
  }
  for (const reverse of [false, true])
    it(`keeps a newer home run over a third out (${reverse ? 'reverse' : 'ordinary'} arrival)`, async () => {
      const { open, load } = await sessions()
      const initial = await open()
      strikeout(initial)
      strikeout(initial)
      await initial.flush()
      const a = await open()
      const b = await open()
      strikeout(a)
      apply(b, { type: 'result', eventType: 'home_run' })
      apply(b, { type: 'gameFlow', kind: 'closePlay' })
      for (const session of reverse ? [b, a] : [a, b]) await session.flush()
      const saved = await load()
      expect(saved.plays.map(play => play.result.eventType)).deep.equals([
        'strikeout',
        'strikeout',
        'home_run'
      ])
      const final = await open()
      expect(final.state.liveData.linescore.outs).equals(2)
      expect(final.state.liveData.linescore.currentInning).equals(1)
      expect(final.state.liveData.linescore.teams.away.runs).equals(1)
    })
  it('rewinds across an inning without retaining a peer’s superseded tail', async () => {
    const { open, load } = await sessions()
    const a = await open()
    strikeout(a)
    strikeout(a)
    strikeout(a)
    await a.flush()
    const b = await open()
    apply(b, { type: 'pitch', call: 'B' })
    expect(a.undo().problems).deep.equals([])
    expect(a.undo().problems).deep.equals([])
    await b.flush()
    await a.flush()
    expect((await load()).plays).has.length(2)
    const final = await open()
    expect(final.state.liveData.linescore.outs).equals(2)
    expect(final.state.liveData.plays.currentPlay?.count).deep.equals({
      balls: 0,
      strikes: 2,
      outs: 2
    })
  })
  it('keeps a coach’s independent order while rebasing a later scoring action', async () => {
    const { open, load } = await sessions()
    const initial = await open()
    apply(initial, { type: 'pitch', call: 'B' })
    await initial.flush()
    const a = await open()
    const coach = await open()
    const order = [...setupOf(coach.state).sides.away.battingOrder]
    // Reorder two future batters, keeping the player at the plate stable.
    ;[order[2], order[3]] = [order[3], order[2]]
    apply(a, { type: 'pitch', call: 'C' })
    apply(coach, { type: 'lineup', kind: 'battingOrder', side: 'away', order })
    await coach.flush()
    await a.flush()
    const final = await open()
    expect(setupOf(final.state).sides.away.battingOrder).deep.equals(order)
    expect((await load()).currentPlay?.count).deep.equals({
      balls: 1,
      strikes: 1,
      outs: 0
    })
  })
  it('retains newer local input authored while a losing save reads the winner', async () => {
    const { open, load, hooks } = await sessions()
    const a = await open()
    const b = await open()
    apply(a, { type: 'pitch', call: 'B' })
    apply(b, { type: 'pitch', call: 'C' })
    await b.flush()
    let release!: () => void, began!: () => void
    const started = new Promise<void>(resolve => {
      began = resolve
    })
    const ready = new Promise<void>(resolve => {
      release = resolve
    })
    hooks.read = async () => {
      hooks.read = undefined
      began()
      await ready
    }
    const saving = a.flush()
    await started
    apply(a, { type: 'pitch', call: 'B' })
    release()
    await saving
    expect((await load()).currentPlay?.count).deep.equals({
      balls: 2,
      strikes: 0,
      outs: 0
    })
  })
  it('does not let automatic completion become newer authorship than a peer’s hit', async () => {
    const { open, load } = await sessions()
    const a = await open()
    const b = await open()
    apply(a, { type: 'result', eventType: 'single' })
    apply(b, { type: 'result', eventType: 'home_run' })
    apply(b, { type: 'gameFlow', kind: 'closePlay' })
    await b.flush()
    apply(a, { type: 'gameFlow', kind: 'closePlay' })
    await a.flush()
    expect((await load()).plays.map(play => play.result.eventType)).deep.equals(
      ['home_run']
    )
  })

  it('clears the ordering barrier on reset and refuses the old generation', async () => {
    const { open, gameId, requests } = await sessions()
    const a = await open()
    apply(a, { type: 'pitch', call: 'B' })
    await a.flush()
    const game = await db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    const actor = await db
      .selectFrom('users')
      .select('id')
      .executeTakeFirstOrThrow()
    const digest = await gamePlaysDigest(db, game)
    await atomic(
      db,
      async trx =>
        await swapOrReset(trx, gameId, actor.id, {
          playsDigest: digest,
          generation: 0
        })
    )
    const reset = await db
      .selectFrom('games')
      .select(['scoring_mutation', 'play_generation'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(reset).deep.equals({ scoring_mutation: null, play_generation: 1 })
    let rejected = false
    try {
      await postGamePlays(
        db,
        gameId,
        asPostEventsBody({
          plays: [],
          currentPlay: null,
          mode: 'live',
          source: { system: 'teamstation' },
          scoringMutation: requests[0].scoringMutation
        }),
        undefined,
        undefined,
        { expectedGeneration: 0 }
      )
    } catch (error) {
      rejected = true
      expect(String(error)).contains('reset since')
    }
    expect(rejected).equals(true)
  })
  it('retains the ordering barrier through a side swap that preserves plays', async () => {
    const { open, gameId } = await sessions()
    const a = await open()
    apply(a, { type: 'pitch', call: 'B' })
    await a.flush()
    a.undo()
    await a.flush()
    const before = await db
      .selectFrom('games')
      .select('scoring_mutation')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    const actor = await db
      .selectFrom('users')
      .select('id')
      .executeTakeFirstOrThrow()
    const done = await atomic(
      db,
      async trx => await swapOrReset(trx, gameId, actor.id, {})
    )
    expect(done.reset).equals(false)
    expect(
      await db
        .selectFrom('games')
        .select('scoring_mutation')
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
    ).deep.equals(before)
  })
})
