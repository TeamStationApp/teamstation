import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import {
  resumedScoringState,
  scoringReducer
} from '../../app/scoring/scoringMachine'
import { asPostedEdits } from '../../common/api'
import type { PlayEditsData } from '../../common/gameSocket'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { applyPlayEdits } from '../../common/playEdits'
import type { ScoringMutation } from '../../common/scoring/scoringMutation'
import {
  type SaveChange,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { withNames } from '../../common/scoring/storedNames'
import {
  addGame,
  addScorableTeams,
  scratchDatabase
} from '../../test/scoreboardKit'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { swapOrReset } from '../games/resetSwap'
import { drain } from '../statsBuilder/builder'
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
  async function sessions(resolveNames = false): Promise<{
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
        plays: resolveNames
          ? plays.map(play =>
              withNames(play, id => context.setup.players[id]?.fullName)
            )
          : plays,
        currentPlay: resolveNames
          ? withNames(await fold(), id => context.setup.players[id]?.fullName)
          : await fold(),
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
                }),
                undefined,
                undefined,
                { scoringAuthor: true }
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
  for (const change of ['order', 'pitcher', 'substitute'] as const)
    it(`defers a later-boundary coach ${change} across a winning unfinished at-bat and reopen`, async () => {
      const { open, load } = await sessions(true)
      const seed = await open()
      if (change === 'substitute') {
        const initial = setupOf(seed.state)
        initial.sides.away.battingOrder.pop()
        apply(seed, { type: 'lineup', kind: 'roster', setup: initial })
      }
      apply(seed, { type: 'pitch', call: 'C' })
      apply(seed, { type: 'pitch', call: 'C' })
      await seed.flush()
      const older = await open()
      const later = await open()
      const original = later.state.liveData.plays.currentPlay!.matchup
      apply(older, { type: 'pitch', call: 'C' })
      apply(older, { type: 'gameFlow', kind: 'closePlay' })
      await older.flush()
      apply(later, { type: 'pitch', call: 'B' })
      const coach = await open()
      const setup = setupOf(coach.state)
      const order = setup.sides.away.battingOrder
      if (change === 'order') [order[0], order[2]] = [order[2], order[0]]
      else if (change === 'pitcher') {
        const defense = setup.sides.home.defense
        ;[defense.P, defense.SS] = [defense.SS, defense.P]
      } else
        order[0] = setup.sides.away.players.find(id => !order.includes(id))!
      apply(coach, { type: 'lineup', kind: 'roster', setup, keepSlot: true })
      await coach.flush()
      await later.flush()
      expect(later.problem).equals(null)
      const saved = await load()
      expect(saved.currentPlay?.count).deep.includes({ balls: 1, strikes: 2 })
      const savedMatchup = saved.currentPlay?.matchup as GumboPlay['matchup']
      expect(savedMatchup?.batter?.id).equals(original.batter.id)
      expect(savedMatchup?.pitcher?.id).equals(original.pitcher.id)
      const reopened = await open()
      expect(
        reopened.state.liveData.plays.currentPlay?.matchup.batter.id
      ).equals(original.batter.id)
      apply(reopened, { type: 'pitch', call: 'C' })
      apply(reopened, { type: 'gameFlow', kind: 'closePlay' })
      await reopened.flush()
      const final = await open()
      expect(final.problem).equals(null)
      expect(setupOf(final.state).sides.away.battingOrder).deep.equals(order)
      expect(setupOf(final.state).sides.home.defense).deep.equals(
        setup.sides.home.defense
      )
      expect((await load()).plays[0].matchup?.batter?.id).equals(
        original.batter.id
      )
      expect((await load()).plays[0].matchup?.pitcher?.id).equals(
        original.pitcher.id
      )
    })

  it('keeps peer completion when roster-only Undo replays historical actions', async () => {
    const { open, load } = await sessions(true)
    const scorer = await open()
    const original = [...setupOf(scorer.state).sides.away.battingOrder]
    const order = [...original]
    ;[order[4], order[5]] = [order[5], order[4]]
    apply(scorer, { type: 'lineup', kind: 'battingOrder', side: 'away', order })
    await scorer.flush()
    const peer = await open()
    apply(peer, { type: 'result', eventType: 'hit_by_pitch' })
    apply(peer, { type: 'gameFlow', kind: 'closePlay' })
    await peer.flush()
    expect(scorer.undo().problems).deep.equals([])
    await scorer.flush()
    expect(scorer.problem).equals(null)
    expect(
      (await open()).state.liveData.plays.allPlays.map(
        play => play.result.eventType
      )
    ).deep.equals(['hit_by_pitch'])
    expect((await load()).currentPlay?.about.atBatIndex).equals(1)
    expect(setupOf((await open()).state).sides.away.battingOrder).deep.equals(
      original
    )
  })

  it('keeps a winning result with its original pitcher before a later same-at-bat coach edit', async () => {
    const { open, load } = await sessions(true)
    const older = await open()
    const later = await open()
    const original = later.state.liveData.linescore.defense.P!.id
    apply(older, { type: 'pitch', call: 'B' })
    await older.flush()
    apply(later, { type: 'result', eventType: 'home_run' })
    apply(later, { type: 'gameFlow', kind: 'closePlay' })
    const coach = await open()
    const setup = setupOf(coach.state)
    ;[setup.sides.home.defense.P, setup.sides.home.defense.C] = [
      setup.sides.home.defense.C,
      setup.sides.home.defense.P
    ]
    apply(coach, { type: 'lineup', kind: 'roster', setup, keepSlot: true })
    await coach.flush()
    await later.flush()
    expect(later.problem).equals(null)
    expect((await load()).plays[0].matchup?.pitcher?.id).equals(original)
    expect(setupOf((await open()).state).sides.home.defense.P).equals(
      setup.sides.home.defense.P
    )
  })

  it('retains a later coach edit while a winning out still needs its thrower', async () => {
    const { open } = await sessions(true)
    const older = await open()
    const later = await open()
    strikeout(older)
    await older.flush()
    apply(later, { type: 'result', eventType: 'other_out' })
    const coach = await open()
    const order = [...setupOf(coach.state).sides.away.battingOrder]
    ;[order[4], order[5]] = [order[5], order[4]]
    apply(coach, { type: 'lineup', kind: 'battingOrder', side: 'away', order })
    await coach.flush()
    await later.flush()
    expect(later.problem).equals(null)
    const resumed = await open()
    expect(resumed.state.pending?.outcome).equals('Batter Out — Other')
    expect(resumed.state.deferredLineups).has.length(1)
    apply(resumed, {
      type: 'runnerMovement',
      runner: resumed.state.liveData.plays.currentPlay!.matchup.batter.id,
      to: 'batter',
      out: true,
      fielders: [resumed.state.liveData.linescore.defense.C!.id]
    })
    apply(resumed, { type: 'gameFlow', kind: 'closePlay' })
    await resumed.flush()
    expect(resumed.problem).equals(null)
    expect(setupOf((await open()).state).sides.away.battingOrder).deep.equals(
      order
    )
  })

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
  for (const screenUndo of [false, true])
    for (const started of [false, true])
      it(`keeps peer scoring through a lineup-only undo (screen ${screenUndo}, started ${started})`, async () => {
        const { open, load } = await sessions(true)
        const a = await open()
        if (started) {
          apply(a, { type: 'pitch', call: 'B' })
          await a.flush()
        }
        const original = [...setupOf(a.state).sides.away.battingOrder]
        const order = [...original]
        ;[order[2], order[3]] = [order[3], order[2]]
        let screen = resumedScoringState(a.state, [...a.actions])
        const draft = structuredClone(a.state)
        draft.liveData.boxscore.teams.away.battingOrder = order
        if (screenUndo) {
          screen = scoringReducer(screen, { type: 'ROSTER', draft })
          expect(a.sync(screen.log)).deep.equals([])
        } else
          apply(a, {
            type: 'lineup',
            kind: 'battingOrder',
            side: 'away',
            order
          })
        await a.flush()
        const b = await open()
        apply(b, { type: 'pitch', call: 'B' })
        await b.flush()
        if (screenUndo) {
          screen = scoringReducer(screen, { type: 'UNDO' })
          expect(a.sync(screen.log)).deep.equals([])
        } else expect(a.undo().problems).deep.equals([])
        expect(
          setupOf(a.state).sides.away.battingOrder,
          'local undo'
        ).deep.equals(original)
        await a.flush()
        expect((await load()).currentPlay?.count).deep.include({
          balls: started ? 2 : 1
        })
        expect(
          setupOf((await open()).state).sides.away.battingOrder
        ).deep.equals(original)
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
  it('refuses a stamped rewind that omits the current-play state', async () => {
    const { open, gameId, load } = await sessions()
    const scorer = await open()
    apply(scorer, { type: 'result', eventType: 'hit_by_pitch' })
    apply(scorer, { type: 'gameFlow', kind: 'closePlay' })
    await scorer.flush()
    const before = await load()
    expect(before.plays).length(1)
    let rejected = false
    try {
      await postGamePlays(
        db,
        gameId,
        asPostEventsBody({
          mode: 'live',
          source: { system: 'teamstation' },
          plays: [],
          remove: [],
          scoringMutation: {
            at: Date.now(),
            id: 'missing-current-state',
            revision: 0,
            frontier: 0
          }
        })
      )
    } catch (error) {
      rejected = true
      expect(String(error)).contains('currentPlay')
    }
    expect(rejected).equals(true)
    expect(await load()).deep.equals(before)
  })

  it('preserves the scoring barrier for internal projection writes', async () => {
    const { open, gameId, requests } = await sessions()
    const a = await open()
    a.apply({ type: 'pitch', call: 'B' })
    await a.flush()
    const {
      scoringMutation: _ignored,
      scoringHistory: _history,
      scoringBase: _scoringBase,
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

  for (const ahead of [0, 3000])
    it(`orders a legacy direct score after a modern clock ${ahead}ms ahead`, async () => {
      const { open, gameId, requests, load } = await sessions()
      const a = await open()
      a.apply({ type: 'pitch', call: 'B' })
      await a.flush()
      a.apply({ type: 'pitch', call: 'C' })
      await a.flush()
      const modern = asPostEventsBody({
        ...requests[1],
        mode: 'live',
        source: { system: 'teamstation' },
        scoringMutation: {
          ...requests[1].scoringMutation!,
          at: Date.now() + ahead,
          id: 'future-modern'
        }
      })
      await postGamePlays(db, gameId, modern)
      const {
        scoringMutation: _ignored,
        scoringHistory: _history,
        scoringBase: _scoringBase,
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
      expect((await load()).scoringMutation!.at).greaterThan(
        modern.scoringMutation!.at
      )
      const reply = await postGamePlays(db, gameId, modern)
      expect(reply.superseded).equals(true)
      expect((await load()).currentPlay?.count).deep.equals({
        balls: 1,
        strikes: 0,
        outs: 0
      })
    })
  it('orders resumed scoring without treating an imported prefix as a coach edit', async () => {
    const { open, gameId, load, requests } = await sessions()
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        plays: [
          {
            about: {
              atBatIndex: 0,
              inning: 1,
              halfInning: 'top',
              isComplete: true
            },
            result: { eventType: 'strikeout', awayScore: 0, homeScore: 0 },
            count: { outs: 1 },
            playEvents: []
          }
        ],
        source: { system: 'outside' }
      })
    )
    await db
      .updateTable('games')
      .set({ status: 'inProgress' })
      .where('id', '=', gameId)
      .execute()
    const original = (await readPlays(db, gameId))[0]
    const a = await open()
    const b = await open()
    expect(a.problem).equals(null)
    expect(b.apply({ type: 'pitch', call: 'C' }).problems).deep.equals([])
    await b.flush()
    expect(a.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    await a.flush()
    expect(a.rebases).equals(0)
    expect(a.problem).equals(null)
    expect(requests).length(2)
    expect((await load()).currentPlay?.count).deep.includes({
      balls: 1,
      strikes: 0
    })
    expect((await readPlays(db, gameId))[0]).deep.equals(original)
  })

  it('preserves imported history when ending before any editable at-bat', async () => {
    const { open, gameId, load, requests } = await sessions()
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        plays: [
          {
            about: {
              atBatIndex: 0,
              inning: 1,
              halfInning: 'top',
              isComplete: true
            },
            result: { eventType: 'strikeout', awayScore: 0, homeScore: 0 },
            count: { outs: 1 },
            playEvents: []
          }
        ],
        source: { system: 'outside' }
      })
    )
    await db
      .updateTable('games')
      .set({ status: 'inProgress' })
      .where('id', '=', gameId)
      .execute()
    const original = (await readPlays(db, gameId))[0]
    const a = await open()
    expect(a.apply({ type: 'gameFlow', kind: 'endGame' }).problems).deep.equals(
      []
    )
    await a.flush()
    expect(a.problem).equals(null)
    expect(requests[0].scoringMutation?.frontier).equals(1)
    expect(
      (await readPlays(db, gameId)).find(row => row.id === original.id)
    ).deep.equals(original)
    expect(
      (await load()).plays.some(play => play.about.atBatIndex === 9999)
    ).equals(true)
    let refused: unknown
    try {
      await postGamePlays(
        db,
        gameId,
        asPostEventsBody({
          ...requests[0],
          mode: 'live',
          source: { system: 'teamstation' },
          scoringMutation: {
            ...requests[0].scoringMutation!,
            at: Date.now(),
            id: 'invalid-imported-frontier',
            frontier: 0
          }
        })
      )
    } catch (error) {
      refused = error
    }
    expect(String(refused)).contains('frontier')
    expect(
      (await readPlays(db, gameId)).find(row => row.id === original.id)
    ).deep.equals(original)
  })

  it('rejects unsupported and duplicate ancestry before storing it', async () => {
    const { open, gameId, requests, load } = await sessions()
    const scorer = await open()
    apply(scorer, { type: 'result', eventType: 'hit_by_pitch' })
    apply(scorer, { type: 'gameFlow', kind: 'closePlay' })
    await scorer.flush()
    apply(scorer, { type: 'pitch', call: 'B' })
    await scorer.flush()
    const before = await load()
    const ancestor = before.plays[0]
    for (const scoringHistory of [
      [{ ...ancestor, teamStation: { version: 999, actions: [] } }],
      [ancestor, ancestor]
    ]) {
      let rejected = false
      try {
        await postGamePlays(
          db,
          gameId,
          asPostEventsBody({
            ...requests[1],
            mode: 'live',
            source: { system: 'teamstation' },
            scoringBase: null,
            scoringHistory,
            scoringMutation: {
              ...requests[1].scoringMutation!,
              at: Date.now(),
              id: 'invalid-history'
            }
          })
        )
      } catch (error) {
        rejected = true
        expect(String(error)).matches(/valid version|history plays share/)
      }
      expect(rejected).equals(true)
      expect(await load()).deep.equals(before)
    }
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
    // The reopened event retains its identity, but is not a completed play.
    expect((await load()).plays).has.length(3)
    const final = await open()
    expect(final.state.liveData.plays.allPlays).has.length(2)
    expect(final.state.liveData.linescore.outs).equals(2)
    expect(final.state.liveData.plays.currentPlay?.count).deep.equals({
      balls: 0,
      strikes: 2,
      outs: 2
    })
  })
  for (const reverse of [false, true])
    it(`removes a competing home run from every score projection (reverse ${reverse})`, async () => {
      const { open, load, gameId } = await sessions()
      const a = await open()
      const b = await open()
      apply(a, { type: 'ballInPlay', contact: 'swing' })
      apply(a, { type: 'result', eventType: 'home_run' })
      apply(a, { type: 'gameFlow', kind: 'closePlay' })
      apply(b, { type: 'pitch', call: 'C' })
      let statsTime = Date.now() + 10000
      for (const scorer of reverse ? [b, a] : [a, b]) {
        await scorer.flush()
        await drain(db, () => new Date(statsTime))
        statsTime += 10000
      }
      const row = await db
        .selectFrom('games')
        .select(['away_score', 'home_score', 'linescore'])
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      expect(row.away_score).equals(null)
      expect(row.home_score).equals(null)
      expect(JSON.stringify(row.linescore)).not.includes('"runs":1')
      const stats = await db
        .selectFrom('game_player_stats')
        .select(['hr', 'r', 'rbi'])
        .where('game_id', '=', gameId)
        .execute()
      for (const field of ['hr', 'r', 'rbi'] as const)
        expect(
          stats.reduce((sum, player) => sum + Number(player[field]), 0),
          field
        ).equals(0)
      const session = await open()
      expect(session.state.liveData.plays.allPlays).length(0)
      expect((await load()).currentPlay?.count).deep.includes({
        balls: 0,
        strikes: 1
      })
    })

  for (const peerAction of ['none', 'correction', 'completion'] as const)
    it(`keeps resumed automatic completion passive during a roster-only save (peer=${peerAction})`, async () => {
      const { open, load, requests } = await sessions(true)
      const first = await open()
      apply(first, { type: 'result', eventType: 'hit_by_pitch' })
      await first.flush()
      const original = requests.at(-1)!.scoringMutation!
      const mounted = await open()
      const resumed = mounted.resumable()
      const display = resumedScoringState(resumed.state, resumed.actions, true)
      if (peerAction !== 'none') {
        const peer = await open()
        if (peerAction === 'correction') {
          expect(peer.undo().problems).deep.equals([])
          apply(peer, { type: 'pitch', call: 'C' })
        } else apply(peer, { type: 'gameFlow', kind: 'closePlay' })
        await peer.flush()
      }
      const draft = structuredClone(display.session)
      const order = draft.liveData.boxscore.teams.away.battingOrder
      ;[order[4], order[5]] = [order[5], order[4]]
      const target = scoringReducer(display, { type: 'ROSTER', draft })
      const sentAt = requests.length
      expect(
        mounted.sync(target.log, [], false, mounted.captureScoringAction())
      ).deep.equals([])
      await mounted.flush()
      expect(mounted.problem).equals(null)
      expect(requests[sentAt].scoringMutation).equals(undefined)
      const final = await open()
      expect(setupOf(final.state).sides.away.battingOrder).deep.equals(order)
      if (peerAction === 'correction') {
        expect(final.state.liveData.plays.allPlays).has.length(0)
        expect((await load()).currentPlay?.count).deep.includes({
          strikes: 1,
          balls: 0
        })
      } else if (peerAction === 'completion') {
        expect(
          final.state.liveData.plays.allPlays.map(play => play.result.eventType)
        ).deep.equals(['hit_by_pitch'])
      } else {
        expect(
          final.state.liveData.plays.allPlays.map(play => play.result.eventType)
        ).deep.equals(['hit_by_pitch'])
        expect((await load()).scoringMutation).deep.includes(original)
        const pitched = scoringReducer(target, { type: 'PITCH', kind: 'ball' })
        const input = mounted.captureScoringAction()
        expect(mounted.sync(pitched.log, [], false, input)).deep.equals([])
        await mounted.flush()
        expect(mounted.problem).equals(null)
        expect((await load()).scoringMutation?.id).equals(input.id)
        expect(
          (await load()).plays.map(play => play.result.eventType)
        ).deep.equals(['hit_by_pitch'])
        expect((await load()).currentPlay?.count).deep.includes({
          balls: 1,
          strikes: 0
        })
      }
    })

  for (const peerPitches of [false, true])
    it(`keeps normalized award completion and peer scoring through roster-only Undo (peer ${peerPitches})`, async () => {
      const { open, load, requests } = await sessions(true)
      const initial = await open()
      apply(initial, { type: 'result', eventType: 'hit_by_pitch' })
      await initial.flush()
      const mounted = await open()
      const resumed = mounted.resumable()
      const display = resumedScoringState(resumed.state, resumed.actions, true)
      const original = [...setupOf(display.session).sides.away.battingOrder]
      const draft = structuredClone(display.session)
      const order = draft.liveData.boxscore.teams.away.battingOrder
      ;[order[4], order[5]] = [order[5], order[4]]
      const roster = scoringReducer(display, { type: 'ROSTER', draft })
      expect(
        mounted.sync(roster.log, [], false, mounted.captureScoringAction())
      ).deep.equals([])
      await mounted.flush()
      if (peerPitches) {
        const peer = await open()
        apply(peer, { type: 'pitch', call: 'B' })
        await peer.flush()
      }
      const stamp = (await load()).scoringMutation
      const undoAt = requests.length
      const undone = scoringReducer(roster, { type: 'UNDO' })
      expect(
        mounted.sync(undone.log, [], false, mounted.captureScoringAction())
      ).deep.equals([])
      await mounted.flush()
      expect(mounted.problem).equals(null)
      expect(
        requests.slice(undoAt).every(request => request.scoringMutation == null)
      ).equals(true)
      const saved = await load()
      expect(saved.scoringMutation).deep.equals(stamp)
      expect(saved.currentPlay?.count).deep.includes({
        balls: peerPitches ? 1 : 0
      })
      const final = await open()
      expect(
        final.state.liveData.plays.allPlays.map(play => play.result.eventType)
      ).deep.equals(['hit_by_pitch'])
      expect(setupOf(final.state).sides.away.battingOrder).deep.equals(original)
    })

  for (const nextPitch of [false, true])
    it(`keeps a delayed winning home run with its original batter across a later coach reorder (next pitch ${nextPitch})`, async () => {
      const { open, load, gameId } = await sessions(true)
      const older = await open()
      const later = await open()
      const original = setupOf(later.state).sides.away.battingOrder[0]
      strikeout(older)
      await older.flush()
      apply(later, { type: 'result', eventType: 'home_run' })
      apply(later, { type: 'gameFlow', kind: 'closePlay' })
      if (nextPitch) apply(later, { type: 'pitch', call: 'B' })
      const coach = await open()
      const order = [...setupOf(coach.state).sides.away.battingOrder]
      ;[order[0], order[2]] = [order[2], order[0]]
      apply(coach, {
        type: 'lineup',
        kind: 'battingOrder',
        side: 'away',
        order
      })
      await coach.flush()
      await later.flush()
      expect(later.problem).equals(null)
      const saved = await load()
      expect(saved.plays[0].result.eventType).equals('home_run')
      expect(saved.plays[0].matchup?.batter?.id).equals(original)
      expect(saved.currentPlay?.count).deep.includes({
        balls: nextPitch ? 1 : 0
      })
      expect(setupOf((await open()).state).sides.away.battingOrder).deep.equals(
        order
      )
      await drain(db, () => new Date(Date.now() + 10000))
      const rows = await db
        .selectFrom('game_player_stats')
        .select(['gumbo_id', 'hr'])
        .where('game_id', '=', gameId)
        .execute()
      expect(rows.filter(row => Number(row.hr) > 0)).has.length(1)
      expect(rows.find(row => Number(row.hr) > 0)?.gumbo_id).equals(original)
    })

  it('retains decorated event identity through saved Undo and recompletion', async () => {
    const { open, gameId } = await sessions()
    const scorer = await open()
    strikeout(scorer)
    await scorer.flush()
    let statsTime = Date.now() + 10000
    const builtStrikeouts = async (): Promise<number> => {
      await drain(db, () => new Date(statsTime))
      statsTime += 10000
      const rows = await db
        .selectFrom('game_player_stats')
        .select('k')
        .where('game_id', '=', gameId)
        .execute()
      return rows.reduce((sum, row) => sum + Number(row.k), 0)
    }
    expect(await builtStrikeouts()).equals(1)
    const before = await db
      .selectFrom('events')
      .selectAll()
      .where('gameId', '=', gameId)
      .executeTakeFirstOrThrow()
    const metadata = {
      hidden: true,
      titleOverride: 'Reviewed strikeout',
      timeNudgeSec: 2
    }
    await db
      .updateTable('events')
      .set(metadata)
      .where('id', '=', before.id)
      .execute()
    const reopened = await open()
    expect(reopened.undo().problems).deep.equals([])
    await reopened.flush()
    expect(await builtStrikeouts()).equals(0)
    apply(reopened, { type: 'gameFlow', kind: 'closePlay' })
    await reopened.flush()
    expect(await builtStrikeouts()).equals(1)
    const after = await db
      .selectFrom('events')
      .selectAll()
      .where('gameId', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(after).includes({ id: before.id, ...metadata })
  })
  for (const reversed of [false, true])
    it(`restores completed ancestry over a competing Undo (reverse ${reversed})`, async () => {
      const { open, load } = await sessions(true)
      const seed = await open()
      apply(seed, { type: 'result', eventType: 'hit_by_pitch' })
      apply(seed, { type: 'gameFlow', kind: 'closePlay' })
      await seed.flush()
      const a = await open()
      const b = await open()
      expect(b.undo().problems).deep.equals([])
      expect(b.undo().problems).deep.equals([])
      apply(a, { type: 'pitch', call: 'B' })
      for (const scorer of reversed ? [a, b] : [b, a]) await scorer.flush()
      expect(
        (await load()).plays.map(play => play.result.eventType)
      ).deep.equals(['hit_by_pitch'])
      expect((await load()).currentPlay?.count).deep.include({ balls: 1 })
      expect((await open()).state.liveData.plays.allPlays).has.length(1)
    })
  it('includes restored ancestors in both the response and socket edit stream', async () => {
    const { open, load, requests, gameId } = await sessions(true)
    const seed = await open()
    apply(seed, { type: 'result', eventType: 'hit_by_pitch' })
    apply(seed, { type: 'gameFlow', kind: 'closePlay' })
    await seed.flush()
    const a = await open()
    const b = await open()
    expect(b.undo().problems).deep.equals([])
    expect(b.undo().problems).deep.equals([])
    apply(a, { type: 'pitch', call: 'B' })
    await a.flush()
    const child = requests.at(-1)!
    // Recreate reversed delivery: rewind first, then deliver the winning child.
    await b.flush()
    const undo = requests.at(-1)!
    const rewound = await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        ...undo,
        mode: 'live',
        source: { system: 'teamstation' },
        scoringMutation: {
          ...undo.scoringMutation!,
          at: Date.now() - 10,
          id: 'rewind-before-child'
        }
      })
    )
    const frames: PlayEditsData[] = []
    const answer = await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        ...child,
        mode: 'live',
        source: { system: 'teamstation' },
        scoringMutation: {
          ...child.scoringMutation!,
          at: Date.now(),
          id: 'restore-child'
        }
      }),
      undefined,
      undefined,
      {
        answer: 'edits',
        cache: {
          get: async () => null,
          set: async (_key, value) => {
            frames.push(JSON.parse(value))
          },
          close: async () => undefined
        }
      }
    )
    expect(
      'edits' in answer &&
        answer.edits.some(
          edit =>
            edit.op === 'put' &&
            (edit.play.gumbo as GumboPlay).about.atBatIndex === 0
        )
    ).equals(true)
    expect(frames).length(1)
    const frame = frames[0]
    const next = applyPlayEdits(
      {
        plays: rewound.plays.map(row => row.gumbo as GumboPlay),
        currentPlay: rewound.currentPlay as CurrentPlay | null,
        generation: frame.generation,
        playsDigest: rewound.playsDigest,
        namesDigest: frame.namesDigest!
      },
      frame
    )
    expect(next).not.equals(null)
    expect(next!.plays.map(play => play.result.eventType)).deep.equals(
      (await load()).plays.map(play => play.result.eventType)
    )
    expect(next!.playsDigest).equals(answer.playsDigest)
  })

  for (const restore of [false, true])
    it(`keeps a coach’s independent lineup history while rebasing scoring (restored ${restore})`, async () => {
      const { open, load } = await sessions()
      const initial = await open()
      apply(initial, { type: 'pitch', call: 'B' })
      await initial.flush()
      const a = await open()
      const coach = await open()
      const order = [...setupOf(coach.state).sides.away.battingOrder]
      const originalOrder = [...order]
      // Reorder two future batters, keeping the player at the plate stable.
      ;[order[2], order[3]] = [order[3], order[2]]
      apply(a, { type: 'pitch', call: 'C' })
      apply(coach, {
        type: 'lineup',
        kind: 'battingOrder',
        side: 'away',
        order
      })
      await coach.flush()
      if (restore) {
        apply(coach, {
          type: 'lineup',
          kind: 'battingOrder',
          side: 'away',
          order: originalOrder
        })
        await coach.flush()
      }
      await a.flush()
      const final = await open()
      expect(setupOf(final.state).sides.away.battingOrder).deep.equals(
        restore ? originalOrder : order
      )
      expect(
        final.actions.filter(action => action.type === 'lineup')
      ).deep.equals(coach.actions.filter(action => action.type === 'lineup'))
      expect((await load()).currentPlay?.count).deep.equals({
        balls: 1,
        strikes: 1,
        outs: 0
      })
    })
  it('retains the original first-pitch identity through an unstamped lineup rebase', async () => {
    const { open, requests, load } = await sessions()
    const scorer = await open()
    const coach = await open()
    apply(scorer, { type: 'pitch', call: 'B' })
    const order = [...setupOf(coach.state).sides.away.battingOrder]
    ;[order[2], order[3]] = [order[3], order[2]]
    apply(coach, { type: 'lineup', kind: 'battingOrder', side: 'away', order })
    await coach.flush()
    expect((await load()).scoringMutation).equals(undefined)
    await scorer.flush()
    const original = requests[1].scoringMutation!
    const retried = requests[2].scoringMutation!
    expect(retried).not.equals(undefined)
    expect(retried.at).equals(original.at)
    expect(retried.id).equals(original.id)
    expect(retried.revision).equals(original.revision + 1)
    expect((await load()).currentPlay?.count).deep.include({ balls: 1 })
    expect(setupOf((await open()).state).sides.away.battingOrder).deep.equals(
      order
    )
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
