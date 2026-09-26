import { expect } from 'chai'
import { describe, it } from 'mocha'

import { F, game, TEAMS } from '../../test/scoringGames'
import { HttpError } from '../errors'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { comparablePlay } from './comparable'
import { recordOf } from './gumbo'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from './session'
import { setupOf } from './state'

/** A server in memory that records every post and can be made to fail. */
class FakeStore implements EventStore {
  plays = new Map<number, { id: string; play: GumboPlay }>()
  current: CurrentPlay | null = null
  posts: SaveChange[] = []
  fail: HttpError | Error | null = null
  gate: Promise<void> | null = null
  private next = 1

  async load(): Promise<StoredGame> {
    return {
      plays: [...this.plays.values()].map(row => row.play),
      currentPlay: this.current
    }
  }

  async save(_gameId: string, change: SaveChange): Promise<StoredGame> {
    this.posts.push(JSON.parse(JSON.stringify(change)) as SaveChange)
    if (this.gate != null) await this.gate
    if (this.fail != null) throw this.fail
    for (const index of change.remove) this.plays.delete(index)
    for (const play of change.plays) {
      const index = play.about.atBatIndex
      const id = this.plays.get(index)?.id ?? `evt_${this.next++}`
      this.plays.set(index, { id, play })
    }
    if (change.currentPlay !== undefined) this.current = change.currentPlay
    return await this.load()
  }

  idOf(index: number): string | undefined {
    return this.plays.get(index)?.id
  }
}

/** Timers the test runs by hand. */
class Clock {
  waiting: Array<{ run: () => void; ms: number }> = []
  options = {
    now: () => new Date('2026-09-25T12:00:00Z'),
    setTimer: (run: () => void, ms: number): unknown => {
      const entry = { run, ms }
      this.waiting.push(entry)
      return entry
    },
    clearTimer: (handle: unknown): void => {
      this.waiting = this.waiting.filter(entry => entry !== handle)
    }
  }

  async tick(): Promise<void> {
    const due = this.waiting
    this.waiting = []
    for (const entry of due) entry.run()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

const context = { gamePk: 'g1', teams: TEAMS, setup: setupOf(game()) }
const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }

async function open(
  store = new FakeStore(),
  clock = new Clock()
): Promise<{ session: ScoringSession; store: FakeStore; clock: Clock }> {
  const session = await ScoringSession.open(store, 'g1', context, clock.options)
  return { session, store, clock }
}

describe('a scoring session', function () {
  it('opens an unscored game and posts nothing until something happens', async function () {
    const { session, store } = await open()
    expect(session.pending).equals(0)
    await session.flush()
    expect(store.posts).deep.equals([])
    expect(session.state.liveData.linescore.offense.batter!.id).equals(1)
  })

  it('posts a lineup set before the first pitch as the current play', async function () {
    const { session, store } = await open()
    session.apply({
      type: 'lineup',
      kind: 'battingOrder',
      side: 'away',
      order: [2, 1, 3, 4, 5, 6, 7, 8, 9]
    })
    expect(session.pending).equals(1)
    await session.flush()
    expect(store.posts).length(1)
    expect(store.posts[0].plays).deep.equals([])
    expect(store.posts[0].remove).deep.equals([])
    const record = recordOf(store.current)!
    expect(record.actions).length(1)
    expect(store.current!.about).deep.include({
      atBatIndex: 0,
      isComplete: false
    })
    expect(session.pending).equals(0)
  })

  it('re-posts the current play on a pitch, and posts the play that ends with the next batter', async function () {
    const { session, store } = await open()
    session.apply(ball)
    await session.flush()
    session.apply({ type: 'result', eventType: 'single' })
    session.apply(ball)
    await session.flush()
    expect(store.posts).length(2)
    const second = store.posts[1]
    expect(second.plays.map(play => play.about.atBatIndex)).deep.equals([0])
    expect(second.plays[0].result.eventType).equals('single')
    expect(second.plays[0].about).deep.include({
      startTime: '2026-09-25T12:00:00.000Z',
      endTime: '2026-09-25T12:00:00.000Z'
    })
    expect(second.currentPlay!.about.atBatIndex).equals(1)
    expect(recordOf(store.plays.get(0)!.play)!.actions).deep.equals([
      ball,
      { type: 'result', eventType: 'single' }
    ])
  })

  it('saves by itself once an action lands', async function () {
    const { session, store, clock } = await open()
    let heard = 0
    const stop = session.subscribe(() => heard++)
    session.apply(ball)
    expect(heard).equals(1)
    expect(clock.waiting).length(1)
    await clock.tick()
    expect(store.posts).length(1)
    expect(heard).equals(2)
    stop()
    session.apply(ball)
    expect(heard).equals(2)
  })

  it('folds two changes made during one post into one follow-up post', async function () {
    const { session, store } = await open()
    let release = (): void => undefined
    store.gate = new Promise(resolve => {
      release = resolve
    })
    session.apply(ball)
    const first = session.flush()
    session.apply(ball)
    session.apply(strike)
    const second = session.flush()
    release()
    store.gate = null
    await first
    await second
    expect(store.posts).length(2)
    const followUp = store.posts[1].currentPlay as unknown as {
      playEvents: unknown[]
    }
    expect(followUp.playEvents).length(3)
  })

  it('keeps the changes while offline, says so, and saves them once the signal is back', async function () {
    const { session, store, clock } = await open()
    store.fail = new HttpError('offline', 'The request never left the device')
    session.apply(ball)
    await session.flush()
    expect(session.offline).equals(true)
    expect(session.pending).equals(1)
    expect(session.problem).equals(null)
    session.apply(strike)
    expect(session.pending).equals(1)
    store.fail = null
    const retry =
      clock.waiting.find(entry => entry.ms === 0) ?? clock.waiting[0]
    expect(retry).not.equals(undefined)
    await clock.tick()
    expect(session.offline).equals(false)
    expect(session.pending).equals(0)
    const last = store.current as unknown as { playEvents: unknown[] }
    expect(last.playEvents).length(2)
  })

  it('backs off a retry after a server error', async function () {
    const { session, store, clock } = await open()
    store.fail = new HttpError('internal', 'Something broke')
    session.apply(ball)
    await session.flush()
    expect(session.problem).equals('Something broke')
    expect(clock.waiting.map(entry => entry.ms)).deep.equals([1000])
    await clock.tick()
    expect(clock.waiting.map(entry => entry.ms)).deep.equals([2000])
  })

  for (const code of ['conflict', 'forbidden'] as const)
    it(`goes read-only on ${code} and stops posting`, async function () {
      const { session, store } = await open()
      store.fail = new HttpError(code, `Refused: ${code}`)
      session.apply(ball)
      await session.flush()
      expect(session.readOnly).equals(true)
      expect(session.problem).equals(`Refused: ${code}`)
      const refused = session.apply(ball)
      expect(refused.problems[0].message).equals(`Refused: ${code}`)
      expect(session.undo().problems[0].message).equals(`Refused: ${code}`)
      store.fail = null
      await session.flush()
      expect(store.posts).length(1)
    })

  it('keeps the changes of a signed-out scorer and saves them once signed in again', async function () {
    const { session, store, clock } = await open()
    session.apply(ball)
    await session.flush()
    store.fail = new HttpError('unauthorized', 'Sign in to continue')
    session.apply(strike)
    session.apply(strike)
    await session.flush()
    expect(session.readOnly).equals(false)
    expect(session.problem).equals('Sign in to continue')
    expect(session.actions).deep.equals([ball, strike, strike])
    expect(session.pending).equals(1)
    expect(clock.waiting.map(entry => entry.ms)).deep.equals([1000])
    store.fail = null
    await clock.tick()
    expect(session.problem).equals(null)
    expect(session.pending).equals(0)
    expect(store.current?.playEvents).length(3)
  })

  it('picks a game left with a ball in play up at the pitch before it, saving nothing', async function () {
    const { session, store } = await open()
    session.apply(ball)
    session.apply({ type: 'ballInPlay', contact: 'swing' })
    session.apply({ type: 'ballInPlay', contact: 'swing', fielder: F.SS })
    await session.flush()
    const posts = store.posts.length
    const resumed = session.resumable()
    expect(resumed.actions).deep.equals([ball])
    expect(resumed.state.liveData.plays.currentPlay?.playEvents).length(1)
    expect(session.actions).length(3)
    expect(session.pending).equals(0)
    await session.flush()
    expect(store.posts).length(posts)
    session.apply({ type: 'result', eventType: 'single' })
    expect(session.resumable().actions).deep.equals(session.actions)
    expect(session.resumable().state).equals(session.state)
  })

  it('goes back to the game the server acknowledged when a save is refused', async function () {
    const { session, store } = await open()
    session.apply(ball)
    await session.flush()
    session.apply(strike)
    session.apply(strike)
    store.fail = new HttpError('forbidden', 'Not yours')
    await session.flush()
    expect(session.readOnly).equals(true)
    expect(session.actions).deep.equals([ball])
    expect(session.state.liveData.plays.currentPlay?.count).includes({
      balls: 1,
      strikes: 0
    })
    expect(session.pending).equals(0)
  })

  it('goes back to the game it opened on when its first save is refused', async function () {
    const store = new FakeStore()
    const first = (await open(store)).session
    first.apply(ball)
    await first.flush()
    const { session } = await open(store)
    session.apply(strike)
    store.fail = new HttpError('forbidden', 'Not yours')
    await session.flush()
    expect(session.actions).deep.equals([ball])
    expect(session.state.liveData.plays.currentPlay?.count).includes({
      balls: 1,
      strikes: 0
    })
  })

  it('reports a bad request once and waits for the next change', async function () {
    const { session, store, clock } = await open()
    store.fail = new HttpError('badRequest', 'play 0: bad')
    session.apply(ball)
    await session.flush()
    expect(session.problem).equals('play 0: bad')
    expect(session.readOnly).equals(false)
    expect(clock.waiting).deep.equals([])
    await session.flush()
    expect(store.posts).length(1)
    store.fail = null
    session.apply(ball)
    await session.flush()
    expect(store.posts).length(2)
    expect(session.problem).equals(null)
  })

  it('opens a game with plays and an at-bat in progress where it was left', async function () {
    const { session, store } = await open()
    session.apply({ type: 'lineup', kind: 'batterSide', batSide: 'L' })
    session.apply({ type: 'result', eventType: 'double' })
    session.apply(ball)
    session.apply(strike)
    await session.flush()
    const again = await open(store)
    expect(again.session.state).deep.equals(session.state)
    expect(again.session.actions).deep.equals(session.actions)
    expect(again.session.pending).equals(0)
    expect(again.session.state.liveData.linescore.balls).equals(1)
  })

  it('opens a game stored before the runners were Gumbo without posting it again, and undoes', async function () {
    const { session, store } = await open()
    session.apply({ type: 'result', eventType: 'single' })
    session.apply(strike)
    await session.flush()
    // The play as it was stored before: numeric bases, the engine's labels.
    const old = store.plays.get(0)!.play as unknown as {
      runners: Array<{ movement: unknown; details: unknown }>
    }
    old.runners = [
      {
        movement: { originBase: 0, start: 0, end: 1, isOut: false },
        details: { runner: { fullName: 'Player 1' }, movementReason: 'Single' }
      }
    ]
    const again = await open(store)
    expect(again.session.pending).equals(0)
    await again.session.flush()
    expect(store.posts).length(1)
    // Undoing the strike reopens the single, stored in Gumbo's shape.
    again.session.undo()
    await again.session.flush()
    const current = store.current as unknown as {
      about: { atBatIndex: number }
      runners: Array<{ movement: { start: unknown; end: unknown } }>
    }
    expect(current.about.atBatIndex).equals(0)
    expect(current.runners.map(r => r.movement)).deep.equals([
      {
        originBase: null,
        start: null,
        end: '1B',
        outBase: null,
        isOut: false,
        outNumber: null
      }
    ])
  })

  it('undoes the action that ended a play and keeps its row until it ends again', async function () {
    const { session, store } = await open()
    session.apply(ball)
    session.apply({ type: 'result', eventType: 'single' })
    session.apply(strike)
    await session.flush()
    const id = store.idOf(0)!
    // The strike closed the single before it was thrown, so undoing it opens
    // play 0 again: its row stays.
    session.undo()
    await session.flush()
    expect(store.posts.at(-1)!.remove).deep.equals([])
    expect(store.current!.about.atBatIndex).equals(0)
    session.undo()
    await session.flush()
    expect(store.posts.at(-1)!.remove).deep.equals([])
    expect(store.idOf(0)).equals(id)
    expect(store.current!.about.atBatIndex).equals(0)
    // Scored again, it keeps its row.
    session.apply({ type: 'result', eventType: 'double' })
    session.apply(ball)
    await session.flush()
    expect(store.idOf(0)).equals(id)
    expect(store.plays.get(0)!.play.result.eventType).equals('double')
  })

  it('removes a reopened play once its first action is undone too', async function () {
    const { session, store } = await open()
    session.apply(ball)
    session.apply({ type: 'result', eventType: 'single' })
    session.apply(strike)
    await session.flush()
    session.undo()
    session.undo()
    session.undo()
    await session.flush()
    expect(store.posts.at(-1)!.remove).deep.equals([0])
    expect(store.plays.size).equals(0)
    expect(session.state.liveData.plays.currentPlay!.playEvents).length(0)
    expect(session.undo().problems[0].message).equals('Nothing to undo')
  })

  it('removes a reopened play undone back to the close of the play before it', async function () {
    const { session, store } = await open()
    session.apply({ type: 'result', eventType: 'single' })
    session.apply({ type: 'gameFlow', kind: 'closePlay' })
    await session.flush()
    const before = await store.load()
    session.apply({ type: 'batteryEvent', kind: 'balk' })
    session.apply({ type: 'result', eventType: 'intent_walk' })
    session.apply({ type: 'gameFlow', kind: 'closePlay' })
    await session.flush()
    expect([...store.plays.keys()]).deep.equals([0, 1])
    // Undone, the walk's play is open again with the balk, and keeps its row.
    session.undo()
    session.undo()
    await session.flush()
    expect([...store.plays.keys()]).deep.equals([0, 1])
    // With the balk undone too it holds only the close of the single.
    session.undo()
    await session.flush()
    expect(store.posts.at(-1)!.remove).deep.equals([1])
    const now = await store.load()
    expect(now.plays).deep.equals(before.plays)
    // Only the times the at-bat was open differ.
    expect(comparablePlay(now.currentPlay)).deep.equals(
      comparablePlay(before.currentPlay)
    )
  })

  it('counts an at-bat open from its first action, not from the close before it', async function () {
    const { session } = await open()
    expect(session.atBatOpen).equals(false)
    session.apply({ type: 'result', eventType: 'single' })
    expect(session.atBatOpen).equals(true)
    session.apply({ type: 'gameFlow', kind: 'closePlay' })
    expect(session.atBatOpen).equals(false)
    session.apply(ball)
    expect(session.atBatOpen).equals(true)
    session.undo()
    expect(session.atBatOpen).equals(false)
    expect(
      session.apply({ type: 'gameFlow', kind: 'endGame' }).problems
    ).deep.equals([])
    expect(session.atBatOpen).equals(false)
  })
  it('reads another scorer’s saved changes again, but never over its own unsaved ones', async function () {
    const store = new FakeStore()
    const mine = (await open(store)).session
    const theirs = (await open(store)).session
    expect(await mine.reload()).equals(false)
    theirs.apply(ball)
    theirs.apply(ball)
    await theirs.flush()
    expect(await mine.reload()).equals(true)
    expect(mine.actions).deep.equals([ball, ball])
    expect(mine.state.liveData.plays.currentPlay?.count.balls).equals(2)
    expect(mine.pending).equals(0)
    store.gate = new Promise(() => undefined)
    mine.apply(strike)
    theirs.apply(ball)
    expect(await mine.reload()).equals(false)
    expect(mine.actions).deep.equals([ball, ball, strike])
  })

  it('goes read-only when another scorer’s saved plays cannot be read back', async function () {
    const store = new FakeStore()
    const mine = (await open(store)).session
    const theirs = (await open(store)).session
    for (const action of [strike, strike, strike, ball]) theirs.apply(action)
    await theirs.flush()
    const first = store.plays.get(0)!.play as unknown as {
      gameStation: { actions: unknown[] }
    }
    first.gameStation.actions.unshift({
      type: 'fieldingPlay',
      fielders: [F.SS],
      error: F.SS
    })
    const stored = JSON.stringify(await store.load())
    const posts = store.posts.length
    expect(await mine.reload()).equals(true)
    expect(mine.readOnly).equals(true)
    expect(mine.problem).match(/^Some saved plays could not be read back: /)
    expect(mine.pending).equals(0)
    expect(mine.removals).deep.equals([])
    expect(mine.apply(ball).problems).deep.equals([
      { code: 'notNow', message: mine.problem }
    ])
    await mine.flush()
    expect(store.posts.length).equals(posts)
    expect(JSON.stringify(await store.load())).equals(stored)
  })

  it('ends the game at 9999 and takes it back on undo', async function () {
    const { session, store } = await open()
    session.apply({ type: 'result', eventType: 'home_run' })
    session.apply({ type: 'gameFlow', kind: 'endGame' })
    await session.flush()
    const final = store.plays.get(9999)!.play
    expect(final.result).includes({ eventType: 'final_score', awayScore: 1 })
    expect(store.current).equals(null)
    session.undo()
    await session.flush()
    expect(store.posts.at(-1)!.remove).deep.equals([9999])
    expect(store.plays.has(9999)).equals(false)
    expect(store.current).not.equals(null)
  })

  it('posts an undo and a redo made while offline as one net change', async function () {
    const { session, store } = await open()
    session.apply({ type: 'result', eventType: 'single' })
    session.apply(ball)
    await session.flush()
    store.fail = new HttpError('offline', 'offline')
    session.undo()
    session.undo()
    session.undo()
    session.apply({ type: 'result', eventType: 'single' })
    session.apply(ball)
    await session.flush()
    store.fail = null
    await session.flush()
    const last = store.posts.at(-1)!
    expect(last.remove).deep.equals([])
    expect(store.plays.has(0)).equals(true)
    session.apply({ type: 'gameFlow', kind: 'endGame' })
    await session.flush()
    store.fail = new HttpError('offline', 'offline')
    session.undo()
    session.apply({ type: 'gameFlow', kind: 'endGame' })
    store.fail = null
    await session.flush()
    expect(store.posts.at(-1)!.remove).deep.equals([])
    expect(store.plays.has(9999)).equals(true)
  })

  it('syncs to the log a screen keeps, undoing back to where they agree', async function () {
    const { session } = await open()
    expect(session.sync([ball, strike, ball])).deep.equals([])
    expect(session.actions).length(3)
    session.sync([ball, ball])
    expect(session.actions).deep.equals([ball, ball])
    expect(session.state.liveData.linescore.balls).equals(2)
    const problems = session.sync([
      ball,
      ball,
      { type: 'fieldingPlay', fielders: [F.SS], error: F.SS }
    ])
    expect(problems[0].message).equals('No error is waiting to be charged')
  })

  it('refuses an action the game cannot take without logging it', async function () {
    const { session } = await open()
    const refused = session.apply({ type: 'gameFlow', kind: 'closePlay' })
    expect(refused.problems[0].message).equals('The play is not decided yet')
    expect(session.actions).length(0)
  })

  it('says when saved actions no longer apply', async function () {
    const store = new FakeStore()
    const { session } = await open(store)
    session.apply(ball)
    await session.flush()
    const broken = JSON.parse(JSON.stringify(store.current)) as {
      gameStation: { actions: unknown[] }
    }
    broken.gameStation.actions.push({
      type: 'fieldingPlay',
      fielders: [F.SS],
      error: F.SS
    })
    store.current = broken as unknown as CurrentPlay
    const again = await open(store)
    expect(again.session.problem).includes('could not be read back')
    expect(again.session.actions).length(1)
  })

  it('shows a game it could not read back in full and never writes to it', async function () {
    const store = new FakeStore()
    const { session } = await open(store)
    for (const action of [strike, strike, strike, ball, ball])
      session.apply(action)
    await session.flush()
    expect([...store.plays.keys()]).deep.equals([0])
    // The first play's log now holds an action that no longer applies, so
    // neither it nor anything after it can be read back.
    const first = store.plays.get(0)!.play as unknown as {
      gameStation: { actions: unknown[] }
    }
    first.gameStation.actions.unshift({
      type: 'fieldingPlay',
      fielders: [F.SS],
      error: F.SS
    })
    const stored = JSON.stringify(await store.load())
    const posts = store.posts.length
    const { session: shown } = await open(store)
    const message = shown.problem!
    expect(message).match(/^Some saved plays could not be read back: /)
    expect(shown.readOnly).equals(true)
    expect(shown.pending).equals(0)
    const refused = [{ code: 'notNow', message }]
    expect(shown.apply(ball).problems).deep.equals(refused)
    expect(shown.undo().problems).deep.equals(refused)
    expect(shown.sync([ball])).deep.equals(refused)
    await shown.flush()
    expect(store.posts).length(posts)
    expect(JSON.stringify(await store.load())).equals(stored)
  })

  it('never writes or removes a play it did not score', async function () {
    const store = new FakeStore()
    store.plays.set(0, {
      id: 'evt_imported',
      play: {
        about: {
          atBatIndex: 0,
          inning: 1,
          halfInning: 'top',
          isComplete: true
        },
        result: { eventType: 'strikeout', awayScore: 0, homeScore: 0 },
        count: { outs: 1 }
      } as unknown as GumboPlay
    })
    const { session } = await open(store)
    expect(session.state.meta.derived).equals(true)
    expect(session.state.liveData.plays.currentPlay!.about.atBatIndex).equals(1)
    session.apply(ball)
    await session.flush()
    expect(store.posts[0].remove).deep.equals([])
    expect(store.idOf(0)).equals('evt_imported')
  })

  it('uses real timers and the clock when none are given', async function () {
    const store = new FakeStore()
    const session = await ScoringSession.open(store, 'g1', context)
    session.apply(ball)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.posts).length(1)
    expect(session.pending).equals(0)
  })
})
