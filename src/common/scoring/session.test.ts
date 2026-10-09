import { expect } from 'chai'
import { describe, it } from 'mocha'

import { F, game, TEAMS } from '../../test/scoringGames'
import { HttpError } from '../errors'
import { completedPlayTag, historyTargets, withTargetTags } from '../eventTags'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { comparablePlay } from './comparable'
import { PlayFolder } from './document'
import { recordOf } from './gumbo'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from './session'
import { asGameState, type GameState, setupOf, type Side } from './state'

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
  it('coalesces the real hit-by-pitch event and retains its tag on completion', async () => {
    const { session, store } = await open()
    expect(
      session.apply({ type: 'result', eventType: 'hit_by_pitch' }).problems
    ).deep.equals([])
    const pitch = session.eventTargets[0]
    expect(session.setEventTag(pitch.id, 'tough batter')).equals(true)
    session.apply({ type: 'gameFlow', kind: 'closePlay' })
    await session.flush()
    const play = store.plays.get(0)!.play
    expect(
      (play.playEvents as Array<{ details: { code: string } }>).at(-1)?.details
        .code
    ).equals('H')
    expect(historyTargets(play)).has.length(1)
    expect(historyTargets(play)[0].id).equals(pitch.id)
    expect(completedPlayTag(play)).equals('tough batter')
  })

  it('reads authoritative tags without replacing pending scoring or local annotations', async () => {
    const { session, store } = await open()
    session.apply(ball)
    await session.flush()
    const target = session.eventTargets[0]
    const version = session.tagSnapshotVersion
    session.setEventTag(target.id, 'local label')
    expect(session.tagSnapshotVersion).equals(version + 1)
    store.current = withTargetTags(
      store.current!,
      new Map([[target.id, 'peer label']])
    )
    session.apply(strike)
    const pending = session.pending
    expect(await session.readEventTag(target.id)).equals('peer label')
    expect(await session.readEventTag('missing_target')).equals(undefined)
    expect(session.eventTargets[0].tag).equals('local label')
    expect(session.pending).equals(pending)
    expect(session.actions).has.length(2)
    session.undo()
    expect(session.pending).equals(0)
    expect(await session.reload()).equals(true)
    expect(session.tagSnapshotVersion).equals(version + 2)
    expect(session.eventTargets[0].tag).equals('peer label')
    expect(await session.reload()).equals(false)
    expect(session.tagSnapshotVersion).equals(version + 2)
    session.apply({ type: 'result', eventType: 'hit_by_pitch' })
    session.apply({ type: 'gameFlow', kind: 'closePlay' })
    await session.flush()
    const completed = session.eventTargets.find(
      item => item.completed === true
    )!
    expect(await session.readEventTag(completed.id)).equals(null)
  })

  it('does not acknowledge newer scoring when a tag save completes later', async () => {
    const { session, store } = await open()
    session.apply(ball)
    await session.flush()
    const target = session.eventTargets[0]
    session.apply(strike)
    expect(session.pending).greaterThan(0)
    session.setEventTag(target.id, 'great pitch')
    expect(session.pending).greaterThan(0)
    await session.flush()
    expect(store.current!.playEvents).has.length(2)
    expect(session.pending).equals(0)
  })
  it('preserves event tags across scoring, reload and metadata-only reload without changing Undo', async () => {
    const { session, store, clock } = await open()
    session.apply(ball)
    session.apply(strike)
    await session.flush()
    const first = session.eventTargets[0]
    const second = session.eventTargets[1]
    expect(session.setEventTag(first.id, 'great pitch')).equals(true)
    expect(session.pending).equals(0)
    expect(session.setEventTag('missing_target', 'tag')).equals(false)
    session.apply(ball)
    expect(session.eventTargets[0].id).equals(first.id)
    expect(session.eventTargets[0].tag).equals('great pitch')
    await session.flush()
    const reopened = (await open(store, clock)).session
    expect(reopened.eventTargets[0]).deep.equals(session.eventTargets[0])
    store.current = withTargetTags(
      store.current!,
      new Map([[first.id, 'new label']])
    )
    expect(await reopened.reload()).equals(true)
    expect(reopened.eventTargets[0].tag).equals('new label')
    reopened.undo()
    reopened.undo()
    reopened.apply(strike)
    expect(reopened.eventTargets[1].id).not.equals(second.id)
    expect(reopened.eventTargets[0].tag).equals('new label')
    expect(reopened.actions).has.length(2)
  })

  it('opens an unscored game and posts nothing until something happens', async function () {
    const { session, store } = await open()
    expect(session.pending).equals(0)
    await session.flush()
    expect(store.posts).deep.equals([])
    expect(session.state.liveData.linescore.offense.batter!.id).equals(1)
  })

  it('plays the game to the fence its context gives, and stores distances on it', async function () {
    const hit: ScoringAction[] = [
      {
        type: 'ballInPlay',
        contact: 'swing',
        location: { x: 0, z: -118 },
        fielder: F.CF
      },
      { type: 'result', eventType: 'double' },
      { type: 'gameFlow', kind: 'closePlay' }
    ]
    const distanceOn = async (
      fenceDistanceFt: number | undefined
    ): Promise<unknown> => {
      const store = new FakeStore()
      const session = await ScoringSession.open(
        store,
        'g1',
        { ...context, fenceDistanceFt },
        new Clock().options
      )
      expect(session.state.gameData.venue?.fieldInfo).deep.equals({
        leftLine: fenceDistanceFt ?? 200,
        center: fenceDistanceFt ?? 200,
        rightLine: fenceDistanceFt ?? 200
      })
      for (const action of hit)
        expect(session.apply(action).problems).deep.equals([])
      await session.flush()
      // Each post says the fence its plays were sized by.
      expect(store.posts).not.have.length(0)
      for (const post of store.posts)
        expect(post.fenceDistanceFt).equals(fenceDistanceFt ?? 200)
      // Read back, the game keeps its fence.
      const again = await ScoringSession.open(store, 'g1', {
        ...context,
        fenceDistanceFt
      })
      expect(again.state.gameData.venue?.fieldInfo.center).equals(
        fenceDistanceFt ?? 200
      )
      const events = store.plays.get(0)!.play.playEvents as Array<{
        hitData?: { totalDistance?: number }
      }>
      return events.find(event => event.hitData != null)?.hitData?.totalDistance
    }
    expect(await distanceOn(undefined)).equals(200)
    expect(await distanceOn(310)).equals(310)
  })

  it('reads a game kept before fences had sizes', function () {
    const older = game() as { gameData: { venue?: unknown } }
    delete older.gameData.venue
    expect(asGameState(older).gameData).not.have.property('venue')
    expect(asGameState(game()).gameData.venue?.fieldInfo.center).equals(200)
  })

  it('posts the default fence for a game kept before fences had sizes', async function () {
    const { session, store } = await open()
    // As a game read back from a copy saved without one would be.
    const kept = session as unknown as { game: GameState; base: GameState }
    for (const state of [kept.game, kept.base]) delete state.gameData.venue
    expect(session.apply(ball).problems).deep.equals([])
    await session.flush()
    expect(session.state.gameData).not.have.property('venue')
    expect(store.posts).not.have.length(0)
    for (const post of store.posts) expect(post.fenceDistanceFt).equals(200)
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
      teamStation: { actions: unknown[] }
    }
    first.teamStation.actions.unshift({
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

  const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
  const out = [strike, strike, strike, close]
  const applyAll = (
    session: ScoringSession,
    actions: ScoringAction[]
  ): void => {
    for (const action of actions)
      expect(session.apply(action).problems, action.type).deep.equals([])
  }
  /** Each stored play's lineup changes, by index: `0 pitching_substitution`. */
  const changes = (store: FakeStore): Record<number, string[]> =>
    Object.fromEntries(
      [
        ...[...store.plays.values()].map(row => row.play),
        ...(store.current == null ? [] : [store.current])
      ].map(play => [
        play.about.atBatIndex,
        (
          (play.playEvents ?? []) as Array<{
            index: number
            isSubstitution?: boolean
            details: Record<string, unknown>
          }>
        )
          .filter(event => event.isSubstitution === true)
          .map(event => `${event.index} ${String(event.details.eventType)}`)
      ])
    )

  describe('a change the side at bat makes to its fielders', function () {
    const swap = (session: ScoringSession, side: Side): ScoringAction => {
      const setup = setupOf(session.state)
      const defense = setup.sides[side].defense
      ;[defense.P, defense.SS] = [defense.SS, defense.P]
      return { type: 'lineup', kind: 'roster', setup }
    }

    it('is written first in the play that side next fields, through undo and a reopened game', async function () {
      const { session, store } = await open()
      session.apply(ball)
      const swapped = swap(session, 'away')
      const log = [ball, swapped, ...out, ...out, ...out, ball]
      applyAll(session, log.slice(1))
      await session.flush()
      const carried = {
        0: [],
        1: [],
        2: [],
        3: ['0 pitching_substitution', '1 defensive_switch']
      }
      expect(changes(store)).deep.equals(carried)
      const written = await store.load()
      // Opened again in the middle of that play, it writes the same.
      const again = await open(store)
      expect(again.session.actions).deep.equals(log)
      applyAll(again.session, [strike])
      await again.session.flush()
      expect(again.store.posts.at(-1)!.plays).deep.equals([])
      expect(changes(store)).deep.equals(carried)
      // Undone back past the change and played again without it, nothing
      // is carried; played with it again, the stored plays are as before.
      expect(
        again.session.sync(log.filter(action => action !== swapped))
      ).deep.equals([])
      await again.session.flush()
      expect(changes(store)).deep.equals({ 0: [], 1: [], 2: [], 3: [] })
      expect(again.session.sync(log)).deep.equals([])
      await again.session.flush()
      const replayed = await store.load()
      expect(replayed.plays.map(comparablePlay)).deep.equals(
        written.plays.map(comparablePlay)
      )
      expect(comparablePlay(replayed.currentPlay)).deep.equals(
        comparablePlay(written.currentPlay)
      )
    })

    it('is written nowhere when the game ends before that side fields again', async function () {
      const { session, store } = await open()
      applyAll(session, [...out, ...out, ...out, ball])
      const swapped = swap(session, 'home')
      applyAll(session, [
        swapped,
        ...out,
        { type: 'gameFlow', kind: 'endGame' }
      ])
      await session.flush()
      expect(store.current).equals(null)
      expect(changes(store)).deep.equals({
        0: [],
        1: [],
        2: [],
        3: [],
        9999: []
      })
      // The lineup changed all the same.
      expect(session.state.liveData.boxscore.teams.home.defense.P).equals(F.SS)
    })

    it('is written as its net change, the same through undo and a reopened game', async function () {
      const { session, store } = await open()
      session.apply(ball)
      const swapped = swap(session, 'away')
      applyAll(session, [swapped, ...out, ...out, ...out])
      // Swapped back at the break, before the first pitch: nothing changed.
      const back = swap(session, 'away')
      applyAll(session, [back, ball])
      await session.flush()
      expect(changes(store)).deep.equals({ 0: [], 1: [], 2: [], 3: [] })
      // Opened again, it writes the same.
      const again = await open(store)
      applyAll(again.session, [strike])
      await again.session.flush()
      expect(changes(store)).deep.equals({ 0: [], 1: [], 2: [], 3: [] })
      // Undone to before the swap back, the swap is announced again.
      again.session.undo()
      again.session.undo()
      again.session.undo()
      await again.session.flush()
      expect(changes(store)).deep.equals({
        0: [],
        1: [],
        2: [],
        3: ['0 pitching_substitution', '1 defensive_switch']
      })
    })
  })

  describe('a pinch hitter sent in before his turn', function () {
    // Away Bench and Away Two come off the bench as 19 and 20.
    const bench = (name: string, side: Side = 'away'): ScoringAction => ({
      type: 'lineup',
      kind: 'addPlayer',
      side,
      name
    })
    const sub = (
      player: number,
      replaces: number,
      side: Side = 'away'
    ): ScoringAction => ({
      type: 'lineup',
      kind: 'substitute',
      side,
      player,
      replaces
    })
    const K = [strike, strike, strike, close]
    const outs = (times: number): ScoringAction[] =>
      Array.from({ length: times }, () => K).flat()
    const logs = {
      // For Away 2 on deck, while Away 1 bats: he bats next, then fields.
      onDeck: [bench('Away Bench'), ball, sub(19, 2), ...K, ...outs(5)],
      // For Away 3, and replaced by Away Two before his turn.
      replaced: [
        bench('Away Bench'),
        bench('Away Two'),
        ball,
        sub(19, 3),
        ...K,
        ball,
        sub(20, 19),
        ...K,
        ...outs(4)
      ],
      // For Away 4 on deck, when Away 3 makes the third out.
      fieldsFirst: [
        bench('Away Bench'),
        ...outs(2),
        ball,
        sub(19, 4),
        ...K,
        ...outs(4)
      ],
      // For Away 2 on deck, and Away 2 put back before his turn.
      putBack: [
        bench('Away Bench'),
        ball,
        sub(19, 2),
        sub(2, 19),
        ...K,
        ...outs(5)
      ]
    }
    // Top 2: for Away 3, who made the last out, then placed on second.
    const placed = [
      bench('Away Bench'),
      ...outs(6),
      sub(19, 3),
      {
        type: 'gameFlow',
        kind: 'placeRunner',
        runner: 19,
        base: '2B'
      } satisfies ScoringAction,
      ...outs(4)
    ]
    const straight = async (log: ScoringAction[]): Promise<FakeStore> => {
      const { session, store } = await open()
      applyAll(session, log)
      await session.flush()
      return store
    }
    const written = (store: FakeStore): unknown => ({
      plays: [...store.plays.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, row]) => comparablePlay(row.play)),
      current: comparablePlay(store.current)
    })

    it('is announced when he bats or is placed on base, as a fielder when his side fields first, and not when put back', async function () {
      expect(changes(await straight(logs.onDeck))).deep.equals({
        0: [],
        1: ['0 offensive_substitution'],
        2: [],
        3: ['0 defensive_switch'],
        4: [],
        5: [],
        6: []
      })
      expect(changes(await straight(logs.replaced))).deep.equals({
        0: [],
        1: [],
        2: ['0 offensive_substitution'],
        3: ['0 defensive_switch'],
        4: [],
        5: [],
        6: []
      })
      expect(changes(await straight(logs.fieldsFirst))).deep.equals({
        0: [],
        1: [],
        2: [],
        3: ['0 defensive_substitution'],
        4: [],
        5: [],
        6: [],
        7: []
      })
      expect(
        Object.values(changes(await straight(logs.putBack))).flat()
      ).deep.equals([])
      const extra = changes(await straight(placed))
      expect(extra[6]).deep.equals(['1 offensive_substitution'])
      expect(extra[9]).deep.equals(['0 defensive_switch'])
      expect(Object.values(extra).flat()).has.length(2)
    })

    it('writes the same after any undo, redo or reopening', async function () {
      this.timeout(60000)
      for (const [name, log] of Object.entries(logs)) {
        const prefixes: unknown[] = []
        for (let at = 0; at <= log.length; at++)
          prefixes.push(written(await straight(log.slice(0, at))))
        const full = prefixes[log.length]
        for (let undone = 1; undone < log.length; undone++) {
          const { session, store } = await open()
          applyAll(session, log)
          for (let i = 0; i < undone; i++) session.undo()
          await session.flush()
          expect(written(store), `${name} undo ${undone}`).deep.equals(
            prefixes[log.length - undone]
          )
          applyAll(session, log.slice(log.length - undone))
          await session.flush()
          expect(written(store), `${name} redo ${undone}`).deep.equals(full)
        }
        for (let at = 0; at <= log.length; at++) {
          const again = await open(await straight(log.slice(0, at)))
          applyAll(again.session, log.slice(at))
          await again.session.flush()
          expect(written(again.store), `${name} reopened at ${at}`).deep.equals(
            full
          )
        }
      }
    })

    it('is written nowhere, nor is a pitching change, once undone', async function () {
      const undone = async (
        before: ScoringAction[],
        change: ScoringAction,
        rest: ScoringAction[]
      ): Promise<void> => {
        const { session, store } = await open()
        applyAll(session, [...before, change])
        session.undo()
        applyAll(session, rest)
        await session.flush()
        expect(written(store)).deep.equals(
          written(await straight([...before, ...rest]))
        )
        expect(Object.values(changes(store)).flat()).deep.equals([])
      }
      // For the batter, for the man on deck, and a pitcher in the field.
      await undone([bench('Away Bench'), ...K, ball], sub(19, 2), [
        ...K,
        ...outs(4)
      ])
      await undone([bench('Away Bench'), ...K, ball], sub(19, 3), [
        ...K,
        ...outs(4)
      ])
      await undone(
        [bench('Home Bench', 'home'), ...K, ball],
        sub(19, F.P, 'home'),
        [...K, ...outs(4)]
      )
    })
  })

  it('folds every play of a game in one pass, however long the game', async function () {
    // Each save folds the whole game (`picture`); who has been announced is
    // carried from play to play, not rebuilt from the first play for each.
    const folded = async (
      halves: number
    ): Promise<{ steps: number; plays: number }> => {
      const { session } = await open()
      applyAll(session, Array.from({ length: halves * 3 }, () => out).flat())
      const before = PlayFolder.steps
      const picture = session.picture()
      return { steps: PlayFolder.steps - before, plays: picture.plays.size }
    }
    const nine = await folded(18)
    const eighteen = await folded(36)
    expect(nine.plays).equals(54)
    expect(eighteen.plays).equals(108)
    // Each completed play once, and the at-bat in progress.
    expect(nine.steps).equals(55)
    expect(eighteen.steps).equals(109)
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
      teamStation: { actions: unknown[] }
    }
    broken.teamStation.actions.push({
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
      teamStation: { actions: unknown[] }
    }
    first.teamStation.actions.unshift({
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
    expect(shown.removals).deep.equals([])
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
  it('undoes and syncs from the newest play it finished, to the same game as a replay from the start', async function () {
    const { session } = await open()
    const walk = [ball, ball, ball, ball, close]
    const log = Array.from({ length: 30 }, (_, index) =>
      index % 3 === 0 ? walk : out
    ).flat()
    applyAll(session, [...log, ball, strike])
    // Scoring state excludes opaque annotations and times: a play an Undo
    // reopens keeps the time it ended, as it always has.
    const seen = (from: ScoringSession): string => {
      const { plays, current } = from.picture()
      const timeless = (play: { about: object } | null): unknown =>
        play == null
          ? null
          : { ...play, about: { ...play.about, startTime: 0, endTime: 0 } }
      return JSON.stringify(
        [
          from.state,
          [...plays].map(([index, play]) => [index, timeless(play)]),
          timeless(current)
        ],
        (key, value) => (key === 'tagTargets' ? undefined : value)
      )
    }
    const replayed = async (actions: ScoringAction[]): Promise<string> => {
      const fresh = (await open()).session
      applyAll(fresh, actions)
      return seen(fresh)
    }
    // Back across plays it finished, one step at a time.
    for (let step = 1; step <= 9; step++) {
      session.undo()
      expect(session.actions).length(log.length + 2 - step)
      expect(seen(session)).equals(
        await replayed([...log, ball, strike].slice(0, log.length + 2 - step))
      )
    }
    // A screen's shorter log, then its longer one again.
    session.sync(log.slice(0, 40))
    expect(seen(session)).equals(await replayed(log.slice(0, 40)))
    session.sync(log)
    expect(seen(session)).equals(await replayed(log))
  })

  it('folds only the plays completed since it last folded, as folding them all again would', async function () {
    const store = new FakeStore()
    const { session } = await open(store)
    // What the session folds, and the same folded again from nothing.
    const check = (): number => {
      const before = PlayFolder.steps
      const picture = session.picture()
      const steps = PlayFolder.steps - before
      // Its caches, emptied for the second fold and put back after.
      const inner = session as unknown as {
        folded: unknown
        foldedPlays: unknown
      }
      const held = { ...inner }
      inner.folded = null
      inner.foldedPlays = null
      const again = session.picture()
      inner.folded = held.folded
      inner.foldedPlays = held.foldedPlays
      expect(JSON.stringify([...picture.plays])).equals(
        JSON.stringify([...again.plays])
      )
      expect(JSON.stringify(picture.current)).equals(
        JSON.stringify(again.current)
      )
      return steps
    }
    const walk = [ball, ball, ball, ball, close]
    const bench: ScoringAction = {
      type: 'lineup',
      kind: 'addPlayer',
      side: 'away',
      name: 'Away Bench'
    }
    const sub: ScoringAction = {
      type: 'lineup',
      kind: 'substitute',
      side: 'away',
      player: 19,
      replaces: 2
    }
    const log = [
      ...Array.from({ length: 24 }, (_, index) =>
        index % 2 === 0 ? walk : out
      ).flat(),
      bench,
      ball,
      sub,
      ...out,
      ...walk,
      ...out
    ]
    const most: number[] = []
    for (const action of log) {
      expect(session.apply(action).problems).deep.equals([])
      const steps = check()
      // A change of players folds the game again; nothing else does.
      if (action !== bench && action !== sub) most.push(steps)
    }
    expect(Math.max(...most)).lessThan(4)
    // A player renamed changes every play he was in, so all are folded again.
    const renamed = setupOf(session.state)
    renamed.players[2] = { ...renamed.players[2], fullName: 'Renamed Two' }
    expect(
      session.apply({ type: 'lineup', kind: 'roster', setup: renamed }).problems
    ).deep.equals([])
    expect(session.state.gameData.players[2].fullName).equals('Renamed Two')
    expect(check()).greaterThan(20)
    // Including the plays he was in before.
    const first = [...session.picture().plays.values()].find(play =>
      JSON.stringify(play).includes('Renamed Two')
    )
    expect(first?.about.atBatIndex).lessThan(5)
    // Back across plays it finished, and on again.
    for (let step = 0; step < 12; step++) {
      session.undo()
      check()
    }
    expect(session.sync(log)).deep.equals([])
    check()
    session.apply({ type: 'lineup', kind: 'roster', setup: renamed })
    check()
    // Another scorer's pitch, read again, folds as the server holds it.
    await session.flush()
    const other = (await open(store)).session
    other.apply(ball)
    await other.flush()
    expect(await session.reload()).equals(true)
    check()
    session.apply(ball)
    expect(check()).lessThan(4)
  })

  it('folds the game once per change, however often it is asked', async function () {
    const { session } = await open()
    applyAll(session, [...out, ...out, ball])
    const first = session.picture()
    const steps = PlayFolder.steps
    expect(session.picture()).equals(first)
    expect(session.pending).greaterThan(0)
    expect(PlayFolder.steps).equals(steps)
    session.apply(strike)
    const next = session.picture()
    expect(next).not.equals(first)
    expect(next.current).not.deep.equals(first.current)
  })
})
