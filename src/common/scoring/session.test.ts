import { expect } from 'chai'
import { describe, it } from 'mocha'

import { lineupsDigest } from '../../server/events/teamLineups'
import { F, game, TEAMS } from '../../test/scoringGames'
import { expectNamesRoundTrip } from '../../test/storedNamesRoundTrip'
import { HttpError } from '../errors'
import { completedPlayTag, historyTargets, withTargetTags } from '../eventTags'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { comparablePlay } from './comparable'
import { PlayFolder } from './document'
import { storedRecordOf } from './gumbo'
import { addPlayer } from './lineup'
import { readLineups } from './lineupHistory'
import { baseIds, overrideOf, tiebreakerSetupError } from './rules'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type SessionContext,
  type StoredGame
} from './session'
import { asGameState, type GameState, setupOf, type Side } from './state'
import { namesIn, withNames } from './storedNames'

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
    // Every document a session posts names itself back from its stored form.
    for (const play of change.plays) expectNamesRoundTrip(play)
    expectNamesRoundTrip(change.currentPlay, 'current play')
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

/**
 * A server that keeps a digest of the game's lineups, as the real one does,
 * and refuses a save built on lineups somebody else has saved over since.
 * The test moves the digest as another device's save would.
 */
class LineupStore extends FakeStore {
  lineups = 'd0'
  /** The digest the next save accepted leaves, as a lineup change would. */
  moveTo: string | null = null
  refused = 0

  override async load(): Promise<StoredGame> {
    const read = await super.load()
    return {
      ...read,
      playsDigest: JSON.stringify([read.plays, read.currentPlay]),
      lineupsDigest: this.lineups
    }
  }

  override async save(gameId: string, change: SaveChange): Promise<StoredGame> {
    if (
      change.lineupsBase !== undefined &&
      change.lineupsBase !== this.lineups
    ) {
      this.posts.push(JSON.parse(JSON.stringify(change)) as SaveChange)
      this.refused++
      throw new HttpError(
        'conflict',
        'Somebody else changed the lineups since this game was read',
        { stale: true }
      )
    }
    if (this.moveTo != null) this.lineups = this.moveTo
    this.moveTo = null
    const prior = (await this.load()).playsDigest
    return { ...(await super.save(gameId, change)), priorPlaysDigest: prior }
  }
}

/**
 * The digest `lineupsDigest` computes from the stored game. A save moves it
 * when the lineup changes, when someone off the card is added, removed, or
 * edited, when a pinch runner who keeps the order is recorded, and when the
 * batter due changes without any of those.
 */
class HashedLineupStore extends LineupStore {
  constructor() {
    super()
    this.rehash()
  }

  rehash(): string {
    const read = readLineups(
      {
        plays: [...this.plays.values()].map(row => row.play),
        currentPlay: this.current
      },
      context
    )
    this.lineups = lineupsDigest(
      read.sides,
      read.bench,
      read.courtesy,
      read.due
    )
    return this.lineups
  }

  override async save(gameId: string, change: SaveChange): Promise<StoredGame> {
    const saved = await super.save(gameId, change)
    this.rehash()
    return { ...saved, lineupsDigest: this.lineups }
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
  it('persists tiebreaker runners and outs with each action independently undoable after reopening', async () => {
    const { session, store } = await open()
    const runners = session.state.liveData.boxscore.teams.away.battingOrder
    const first = runners[1]
    const second = runners[2]
    expect(
      session.apply({
        type: 'gameFlow',
        kind: 'placeRunner',
        runner: first,
        base: '2B'
      }).problems
    ).deep.equals([])
    const before = JSON.parse(JSON.stringify(session.state.liveData.boxscore))
    const draft = overrideOf(session.state)
    expect(
      session.apply({
        type: 'gameFlow',
        kind: 'override',
        ...draft,
        batter: draft.batter ?? undefined,
        pitcher: draft.pitcher ?? undefined,
        outs: 2
      }).problems
    ).deep.equals([])
    expect(
      session.apply({
        type: 'gameFlow',
        kind: 'placeRunner',
        runner: second,
        base: '1B'
      }).problems
    ).deep.equals([])
    await session.flush()
    const again = await open(store)
    expect(baseIds(again.session.state)).deep.equals([second, first, null])
    expect(again.session.state.liveData.linescore.outs).equals(2)
    expect(tiebreakerSetupError(again.session.state)).equals(undefined)
    expect(again.session.state.liveData.boxscore).deep.equals(before)
    expect(again.session.undo().problems).deep.equals([])
    expect(baseIds(again.session.state)).deep.equals([null, first, null])
    expect(again.session.undo().problems).deep.equals([])
    expect(again.session.state.liveData.linescore.outs).equals(0)
    expect(baseIds(again.session.state)).deep.equals([null, first, null])
    expect(again.session.undo().problems).deep.equals([])
    expect(baseIds(again.session.state)).deep.equals([null, null, null])
    await again.session.flush()
    expect((await open(store)).session.state.liveData.linescore.outs).equals(0)
  })

  it('posts nothing when a player is renamed between its load and its save', async () => {
    const { session, store } = await open()
    for (const action of [strike, strike, strike])
      expect(session.apply(action).problems).deep.equals([])
    session.apply({ type: 'gameFlow', kind: 'closePlay' })
    session.apply(ball)
    await session.flush()
    const posts = store.posts.length
    const batter = store.plays.get(0)!.play.matchup!.batter!.id!
    // Every read names the batter anew, as the server does after a rename.
    const renamed = <T>(document: T): T => {
      const names = namesIn(document)
      return withNames(document, id =>
        id === batter ? 'Ichiro S' : names.get(id)
      )
    }
    for (const row of store.plays.values()) row.play = renamed(row.play)
    store.current = renamed(store.current)
    expect(await session.reload()).equals(true)
    expect(session.state.gameData.players[batter].fullName).equals('Ichiro S')
    await session.flush()
    expect(store.posts).has.length(posts)
    // The next pitch posts the at-bat it changes, and no play renamed.
    session.apply(ball)
    await session.flush()
    expect(store.posts).has.length(posts + 1)
    expect(store.posts.at(-1)!.plays).deep.equals([])
  })

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

  it("takes up the server's word on what a swap does from every read, the plays unchanged or not", async () => {
    class SwapStore extends FakeStore {
      swap: StoredGame['swap'] = 'swap'
      async load(): Promise<StoredGame> {
        return { ...(await super.load()), swap: this.swap }
      }
    }
    const store = new SwapStore()
    const { session } = await open(store)
    expect(session.serverSwap).equals('swap')
    let told = 0
    session.subscribe(() => {
      told++
    })
    // Withdrawn meanwhile: nothing else about the game moved.
    store.swap = 'withdrawn'
    expect(await session.reload()).equals(false)
    expect(session.serverSwap).equals('withdrawn')
    expect(told).equals(1)
    expect(await session.reload()).equals(false)
    expect(told).equals(1)
    // And with plays somebody else saved.
    store.swap = 'reset'
    store.current = (
      await (async () => {
        const other = await open(new FakeStore())
        other.session.apply(ball)
        await other.session.flush()
        return other.store
      })()
    ).current
    expect(await session.reload()).equals(true)
    expect(session.serverSwap).equals('reset')
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

  for (const peer of [false, true])
    it(`refreshes a reload snapshot overtaken by a tag acknowledgment${peer ? ' and peer write' : ''}`, async () => {
      const { session, store } = await open()
      session.apply(ball)
      await session.flush()
      const target = session.eventTargets[0]
      const load = store.load.bind(store)
      let release!: () => void
      let started!: () => void
      let reads = 0
      const reading = new Promise<void>(resolve => {
        started = resolve
      })
      store.load = async () => {
        const result = await load()
        if (++reads === 1) {
          started()
          await new Promise<void>(resolve => {
            release = resolve
          })
        }
        return result
      }
      const reloading = session.reload()
      await reading
      store.current = withTargetTags(
        store.current!,
        new Map([[target.id, 'great pitch']])
      )
      expect(session.setEventTag(target.id, 'great pitch')).equals(true)
      if (peer)
        store.current = withTargetTags(
          store.current,
          new Map([[target.id, 'peer label']])
        )
      release()
      expect(await reloading).equals(peer)
      expect(reads).equals(2)
      expect(session.eventTargets[0].tag).equals(
        peer ? 'peer label' : 'great pitch'
      )
      expect(session.pending).equals(0)
      expect(session.actions).has.length(1)
      expect(session.undo().problems).deep.equals([])
      expect(session.actions).has.length(0)
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
    const record = storedRecordOf(store.current)!
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
    expect(storedRecordOf(store.plays.get(0)!.play)!.actions).deep.equals([
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
    // Told of the acknowledgment, and again once the save has stopped.
    expect(heard).equals(3)
    stop()
    session.apply(ball)
    expect(heard).equals(3)
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

  it('tells its listeners once more when a save stops, and is idle then', async function () {
    const { session, store } = await open()
    const heard: Array<{ saving: boolean; pending: number }> = []
    session.subscribe(() => {
      heard.push({ saving: session.saving, pending: session.pending })
    })
    session.apply(ball)
    heard.length = 0
    expect(session.saving).equals(false)
    const saved = session.flush()
    expect(session.saving).equals(true)
    await saved
    // The save's own notice comes while it still runs; the last is idle.
    expect(heard).deep.equals([
      { saving: true, pending: 0 },
      { saving: false, pending: 0 }
    ])
    expect(store.posts).length(1)
    // Another scorer's post lands just after this one. A reload asked for in
    // the save's own notice declines; in the last it takes that post up.
    const other = await open(store)
    const save = store.save.bind(store)
    let landed = false
    store.save = async (gameId, change) => {
      const answer = await save(gameId, change)
      if (!landed) {
        landed = true
        other.session.apply(strike)
        await other.session.flush()
      }
      return answer
    }
    const reloads: Array<Promise<boolean>> = []
    session.subscribe(() => {
      reloads.push(session.reload())
    })
    session.apply(ball)
    reloads.length = 0
    await session.flush()
    // The reload that took it up tells too, and finds nothing more.
    expect(await Promise.all(reloads)).deep.equals([false, true, false])
    expect(session.actions).deep.equals([ball, strike])
  })

  it('takes a log read back with its keys in another order as the same, keeping its plays and their tag ids', async function () {
    const { session, store } = await open()
    const roster: ScoringAction = {
      type: 'lineup',
      kind: 'roster',
      setup: setupOf(game())
    }
    const actions = [roster, strike, strike, strike, ball]
    for (const action of actions) session.apply(action)
    await session.flush()
    const targets = session.eventTargets.map(target => target.id)
    const posts = store.posts.length
    // The same actions with every object's keys reversed, as a copy read
    // back from the server can list them.
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : value != null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, item]) => [key, reversed(item)])
            )
          : value
    const readBack = actions.map(reversed) as ScoringAction[]
    expect(JSON.stringify(readBack)).not.equals(JSON.stringify(actions))
    expect(session.sync(readBack)).deep.equals([])
    expect(session.pending).equals(0)
    expect(session.eventTargets.map(target => target.id)).deep.equals(targets)
    // Taken as the screen's own objects, they compare at once next time.
    expect(
      session.actions.every((action, index) => action === readBack[index])
    ).equals(true)
    session.apply(ball)
    await session.flush()
    expect(
      session.eventTargets.map(target => target.id).slice(0, targets.length)
    ).deep.equals(targets)
    expect(store.posts.length).equals(posts + 1)
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
      player: name === 'Away Two' ? 20 : 19,
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

  describe('saved over by another device’s lineups', function () {
    /** Another device saves the lineups, as a coach saves his side. */
    async function coachSaves(
      store: LineupStore,
      change: (setup: ReturnType<typeof setupOf>) => void
    ): Promise<ScoringAction> {
      const coach = (await open(store)).session
      const setup = setupOf(coach.state)
      change(setup)
      const roster: ScoringAction = { type: 'lineup', kind: 'roster', setup }
      expect(coach.apply(roster).problems).deep.equals([])
      store.moveTo = 'coach'
      await coach.flush()
      expect(store.lineups).equals('coach')
      return roster
    }
    const swapLeadoff = (setup: ReturnType<typeof setupOf>): void => {
      const [first, second, ...rest] = setup.sides.home.battingOrder
      setup.sides.home.battingOrder = [second, first, ...rest]
    }
    const swapAwayLeadoff = (setup: ReturnType<typeof setupOf>): void => {
      const [first, second, ...rest] = setup.sides.away.battingOrder
      setup.sides.away.battingOrder = [second, first, ...rest]
    }
    const reverseAway = (setup: ReturnType<typeof setupOf>): void => {
      setup.sides.away.battingOrder = [
        ...setup.sides.away.battingOrder
      ].reverse()
    }
    const addHomeBench = (setup: ReturnType<typeof setupOf>): void => {
      const sample = setup.players[setup.sides.home.battingOrder[0]]
      const id = Math.max(...setup.tagOrder) + 1
      setup.players[id] = {
        id,

        teamId: sample.teamId,
        fullName: 'Home Bench',
        jersey: '99',
        bats: 'right',
        throws: null,
        positions: [],
        local: true
      }
      setup.sides.home.players.push(id)
      setup.tagOrder.push(id)
    }
    const addAwayBench = (setup: ReturnType<typeof setupOf>): void => {
      const sample = setup.players[setup.sides.away.battingOrder[0]]
      const id = Math.max(...setup.tagOrder) + 1
      setup.players[id] = {
        id,

        teamId: sample.teamId,
        fullName: 'Away Bench',
        jersey: '98',
        bats: 'right',
        throws: null,
        positions: [],
        local: true
      }
      setup.sides.away.players.push(id)
      setup.tagOrder.push(id)
    }

    it('names the generation it opened on, and on a refusal naming another is replaced rather than rebased (A8)', async function () {
      /** A server whose game a reset moved to generation 1 after it was read. */
      class ResetStore extends LineupStore {
        generation = 0
        override async load(): Promise<StoredGame> {
          return { ...(await super.load()), generation: this.generation }
        }

        override async save(
          gameId: string,
          change: SaveChange
        ): Promise<StoredGame> {
          if (
            change.generation !== undefined &&
            change.generation !== this.generation
          ) {
            this.posts.push(JSON.parse(JSON.stringify(change)) as SaveChange)
            throw new HttpError(
              'conflict',
              'This game was reset since it was read',
              { stale: true, generation: this.generation }
            )
          }
          return await super.save(gameId, change)
        }
      }
      const store = new ResetStore()
      const { session } = await open(store)
      expect(session.generation).equals(0)
      session.apply(ball)
      await session.flush()
      expect(store.posts.at(-1)!.generation).equals(0)
      expect(session.replaced).equals(false)
      store.generation = 1
      let told = 0
      session.subscribe(() => told++)
      session.apply(strike)
      await session.flush()
      expect(session.replaced).equals(true)
      expect(told).above(0)
      // Neither taken up under the reset game nor sent again.
      const posts = store.posts.length
      session.apply(ball)
      await session.flush()
      expect(store.posts.length).equals(posts)
      expect(session.pending).above(0)
      expect(session.rebases).equals(0)
    })

    it('names the digest each answer and each read leaves as the next base', async function () {
      const store = new LineupStore()
      const { session } = await open(store)
      session.apply(ball)
      // Its own lineup change moves the digest; the answer says so.
      store.moveTo = 'mine'
      await session.flush()
      session.apply(strike)
      await session.flush()
      expect(store.posts.map(post => post.lineupsBase)).deep.equals([
        'd0',
        'mine'
      ])
      // Read again, it takes the server's digest up, changed game or not.
      store.lineups = 'read'
      expect(await session.reload()).equals(false)
      session.apply(ball)
      await session.flush()
      expect(store.posts.at(-1)!.lineupsBase).equals('read')
      expect(store.refused).equals(0)
    })

    it('holds the digests it reads and saves, and none of the plays once a save finds another’s', async function () {
      const store = new LineupStore()
      const { session } = await open(store)
      const opened = (await store.load()).playsDigest!
      expect(session.holdsPlays(opened)).equals(true)
      expect(session.holdsLineups('d0')).equals(true)
      session.apply(ball)
      store.moveTo = 'mine'
      await session.flush()
      const mine = (await store.load()).playsDigest!
      expect(session.holdsPlays(mine)).equals(true)
      expect(session.holdsPlays(opened)).equals(true)
      expect(session.holdsLineups('mine')).equals(true)
      // Another scorer's pitch lands before this one's.
      const theirs = (await open(store)).session
      theirs.apply(strike)
      await theirs.flush()
      session.apply(ball)
      await session.flush()
      expect(session.holdsPlays((await store.load()).playsDigest!)).equals(
        false
      )
      expect(session.holdsPlays(mine)).equals(false)
      // Read again, it holds what it read, the same game or not.
      await session.reload()
      expect(session.holdsPlays((await store.load()).playsDigest!)).equals(true)
    })

    it('keeps the time an unsaved pitch was taken when it puts the pitch back on the lineups', async function () {
      const store = new LineupStore()
      const clock = new Clock()
      let at = '2026-09-25T12:00:00.000Z'
      clock.options.now = () => new Date(at)
      const { session } = await open(store, clock)
      session.apply(ball)
      await session.flush()
      await coachSaves(store, swapLeadoff)
      at = '2026-09-25T12:00:20.000Z'
      session.apply(strike)
      // The save, its refusal and the rebase all come later than the pitch.
      at = '2026-09-25T12:00:45.000Z'
      await session.flush()
      expect(session.rebases).equals(1)
      const stored = (await store.load()).currentPlay as unknown as {
        teamStation: { actions: ScoringAction[]; actionTimes: string[] }
      }
      expect(stored.teamStation.actions.at(-1)).deep.equals(strike)
      expect(stored.teamStation.actionTimes[0]).equals(
        '2026-09-25T12:00:00.000Z'
      )
      expect(stored.teamStation.actionTimes.at(-1)).equals(
        '2026-09-25T12:00:20.000Z'
      )
      expect(stored.teamStation.actionTimes).length(
        stored.teamStation.actions.length
      )
    })

    it("puts back another device's stored run after a third out, as stored", async function () {
      const store = new LineupStore()
      const { session } = await open(store)
      const runner = session.state.liveData.boxscore.teams.away.battingOrder[1]
      const draft = overrideOf(session.state)
      expect(
        session.apply({
          type: 'gameFlow',
          kind: 'override',
          ...draft,
          batter: draft.batter ?? undefined,
          pitcher: draft.pitcher ?? undefined,
          outs: 2
        }).problems
      ).deep.equals([])
      expect(
        session.apply({
          type: 'gameFlow',
          kind: 'placeRunner',
          runner,
          base: '3B'
        }).problems
      ).deep.equals([])
      session.apply(ball)
      await session.flush()
      // Undone here, while another device scores the catch for the third out.
      session.undo()
      const other = (await open(store)).session
      const leftFielder = other.state.liveData.linescore.defense.LF!.id
      const catchOut: ScoringAction[] = [
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'fly_ball',
          fielder: leftFielder
        },
        { type: 'result', eventType: 'field_out', outBy: 'catch' }
      ]
      for (const action of catchOut)
        expect(other.apply(action).problems).deep.equals([])
      await other.flush()
      // An older build saved the runner scoring after that catch, as such
      // builds did.
      const run: ScoringAction = { type: 'runnerMovement', runner, to: 'home' }
      const stored = [
        ...[...store.plays.values()].map(row => row.play),
        store.current
      ]
      for (const play of stored) {
        const record = (
          play as unknown as {
            teamStation?: { actions: ScoringAction[] }
          } | null
        )?.teamStation
        const at = record?.actions.findIndex(
          action => action.type === 'result' && action.outBy === 'catch'
        )
        if (record != null && at != null && at >= 0)
          record.actions.splice(at + 1, 0, run)
      }
      await coachSaves(store, swapLeadoff)
      await session.flush()
      expect(session.rebases).equals(1)
      expect(session.problem).equals(null)
      expect(session.actions).deep.includes(run)
    })

    it('leaves a server action that had no time without one when it puts it back', async function () {
      const store = new LineupStore()
      const clock = new Clock()
      const { session } = await open(store, clock)
      session.apply(ball)
      await session.flush()
      // Undone here, while another device saves a lineup after the ball.
      session.undo()
      await coachSaves(store, swapLeadoff)
      // That device's app is older: its actions carry no times.
      const current = store.current as unknown as {
        teamStation: { actionTimes?: string[] }
      }
      delete current.teamStation.actionTimes
      clock.options.now = () => new Date('2026-09-25T12:05:00.000Z')
      await session.flush()
      expect(session.rebases).equals(1)
      const stored = (await store.load()).currentPlay as unknown as {
        teamStation: { actions: ScoringAction[]; actionTimes?: string[] }
      }
      expect(stored.teamStation.actions).length.greaterThan(0)
      expect(stored.teamStation.actionTimes).equals(undefined)
    })

    it('reads the lineups again under its unsaved pitch, and saves the pitch on top', async function () {
      const store = new LineupStore()
      const { session } = await open(store)
      session.apply(ball)
      await session.flush()
      const roster = await coachSaves(store, swapLeadoff)
      const order = setupOf((await open(store)).session.state).sides.home
        .battingOrder
      // The scorer, mid-entry, pitches on the game he read before it.
      const heard: number[] = []
      session.subscribe(() => heard.push(session.rebases))
      session.apply(strike)
      await session.flush()
      expect(store.refused).equals(1)
      expect(session.rebases).equals(1)
      expect(heard).includes(1)
      expect(session.readOnly).equals(false)
      expect(session.problem).equals(null)
      expect(session.pending).equals(0)
      expect(session.actions).deep.equals([ball, roster, strike])
      expect(store.posts.at(-1)!.lineupsBase).equals('coach')
      const stored = (await open(store)).session
      expect(stored.actions).deep.equals([ball, roster, strike])
      expect(setupOf(stored.state).sides.home.battingOrder).deep.equals(order)
      expect(stored.state.liveData.plays.currentPlay?.count).includes({
        balls: 1,
        strikes: 1
      })
    })

    it('drops a change the game no longer takes, and says so', async function () {
      const store = new LineupStore()
      // As the scoring screen opens it: a pitch needs a whole defence.
      const session = await ScoringSession.open(store, 'g1', context, {
        ...new Clock().options,
        requireCurrentSetup: true
      })
      session.apply(ball)
      await session.flush()
      // The coach leaves short empty: no pitch can follow until it is filled.
      const roster = await coachSaves(store, setup => {
        setup.sides.home.defense.SS = null
      })
      session.apply(strike)
      await session.flush()
      expect(session.readOnly).equals(false)
      expect(session.actions).deep.equals([ball, roster])
      expect(session.problem).equals(
        "A change could not follow another device's lineup change: Missing defensive positions: SS"
      )
      expect(session.pending).equals(0)
      // The scorer's next change clears it.
      const shortstop = setupOf(session.state).sides.home.battingOrder[0]
      expect(
        session.apply({
          type: 'lineup',
          kind: 'position',
          side: 'home',
          position: 'SS',
          player: shortstop
        }).problems
      ).deep.equals([])
      expect(session.problem).equals(null)
    })

    it('leaves the visitors coach order when the first pitch was built on the shown default', async function () {
      const store = new LineupStore()
      const session = await ScoringSession.open(store, 'g1', context, {
        ...new Clock().options,
        requireCurrentSetup: true
      })
      const blind = setupOf(session.state)
      const placeholder: ScoringAction = {
        type: 'lineup',
        kind: 'roster',
        setup: blind,
        unseen: ['away'],
        confirmed: ['home']
      }
      expect(session.apply(placeholder).problems).deep.equals([])
      await session.flush()
      expect(store.lineups).equals('d0')
      const coachRoster = await coachSaves(store, swapAwayLeadoff)
      const coachOrder = setupOf((await open(store)).session.state).sides.away
        .battingOrder
      const shown = setupOf(session.state)
      reverseAway(shown)
      const snapshot: ScoringAction = {
        type: 'lineup',
        kind: 'roster',
        setup: shown,
        confirmed: ['away'],
        shown: true
      }
      expect(session.apply(snapshot).problems).deep.equals([])
      expect(session.apply(ball).problems).deep.equals([])
      await session.flush()
      expect(store.refused).equals(1)
      expect(session.rebases).equals(1)
      expect(session.problem).equals(null)
      expect(session.actions).deep.equals([placeholder, coachRoster, ball])
      expect(setupOf(session.state).sides.away.battingOrder).deep.equals(
        coachOrder
      )
      expect(
        session.state.liveData.plays.currentPlay?.matchup.batter.id
      ).equals(coachOrder[0])
      expect(session.state.liveData.plays.currentPlay?.count).includes({
        balls: 1,
        strikes: 0
      })
      const stored = (await open(store)).session
      expect(stored.actions).deep.equals([placeholder, coachRoster, ball])
      expect(setupOf(stored.state).sides.away.battingOrder).deep.equals(
        coachOrder
      )
    })

    it('keeps the home coach order and scores the visitors default', async function () {
      const store = new LineupStore()
      const session = await ScoringSession.open(store, 'g1', context, {
        ...new Clock().options,
        requireCurrentSetup: true
      })
      const blind = setupOf(session.state)
      expect(
        session.apply({
          type: 'lineup',
          kind: 'roster',
          setup: blind,
          unseen: ['away'],
          confirmed: ['home']
        }).problems
      ).deep.equals([])
      await session.flush()
      await coachSaves(store, swapLeadoff)
      const homeOrder = setupOf((await open(store)).session.state).sides.home
        .battingOrder
      const shown = setupOf(session.state)
      reverseAway(shown)
      expect(
        session.apply({
          type: 'lineup',
          kind: 'roster',
          setup: shown,
          confirmed: ['away'],
          shown: true
        }).problems
      ).deep.equals([])
      expect(session.apply(ball).problems).deep.equals([])
      await session.flush()
      expect(store.refused).equals(1)
      expect(session.rebases).equals(1)
      expect(session.problem).equals(null)
      expect(setupOf(session.state).sides.home.battingOrder).deep.equals(
        homeOrder
      )
      expect(setupOf(session.state).sides.away.battingOrder).deep.equals(
        shown.sides.away.battingOrder
      )
      expect(
        session.state.liveData.plays.currentPlay?.matchup.batter.id
      ).equals(shown.sides.away.battingOrder[0])
      const stored = (await open(store)).session
      expect(setupOf(stored.state).sides.home.battingOrder).deep.equals(
        homeOrder
      )
      expect(setupOf(stored.state).sides.away.battingOrder).deep.equals(
        shown.sides.away.battingOrder
      )
    })

    async function coachPosts(
      store: HashedLineupStore,
      change: (setup: ReturnType<typeof setupOf>) => void
    ): Promise<ScoringAction> {
      const coach = (await open(store)).session
      const setup = setupOf(coach.state)
      change(setup)
      const roster: ScoringAction = { type: 'lineup', kind: 'roster', setup }
      expect(coach.apply(roster).problems).deep.equals([])
      await coach.flush()
      return roster
    }

    it('keeps a bench player the home coach added and scores the visitors default', async function () {
      const store = new HashedLineupStore()
      const session = await ScoringSession.open(store, 'g1', context, {
        ...new Clock().options,
        requireCurrentSetup: true
      })
      const blind = setupOf(session.state)
      expect(
        session.apply({
          type: 'lineup',
          kind: 'roster',
          setup: blind,
          unseen: ['away'],
          confirmed: ['home']
        }).problems
      ).deep.equals([])
      await session.flush()
      const before = store.lineups
      await coachPosts(store, addHomeBench)
      const read = readLineups(
        {
          plays: [...store.plays.values()].map(row => row.play),
          currentPlay: store.current
        },
        context
      )
      expect(store.lineups).equals(lineupsDigest(read.sides, read.bench))
      expect(lineupsDigest(read.sides)).equals(before)
      expect(store.lineups).not.equals(before)
      const server = setupOf((await open(store)).session.state)
      const bench = server.sides.home.players.find(
        id => !blind.sides.home.players.includes(id)
      )
      expect(bench).a('number')
      const shown = setupOf(session.state)
      reverseAway(shown)
      expect(
        session.apply({
          type: 'lineup',
          kind: 'roster',
          setup: shown,
          confirmed: ['away'],
          shown: true
        }).problems
      ).deep.equals([])
      expect(session.apply(ball).problems).deep.equals([])
      await session.flush()
      expect(store.refused).equals(1)
      expect(session.rebases).equals(1)
      expect(session.problem).equals(null)
      expect(session.state.gameData.players[bench!].fullName).equals(
        'Home Bench'
      )
      expect(session.state.liveData.boxscore.teams.home.players).includes(bench)
      expect(setupOf(session.state).sides.home.battingOrder).deep.equals(
        server.sides.home.battingOrder
      )
      expect(setupOf(session.state).sides.away.battingOrder).deep.equals(
        shown.sides.away.battingOrder
      )
      expect(
        session.state.liveData.plays.currentPlay?.matchup.batter.id
      ).equals(shown.sides.away.battingOrder[0])
      const stored = (await open(store)).session
      expect(stored.state.gameData.players[bench!].fullName).equals(
        'Home Bench'
      )
      expect(stored.state.liveData.boxscore.teams.home.players).includes(bench)
      expect(setupOf(stored.state).sides.away.battingOrder).deep.equals(
        shown.sides.away.battingOrder
      )
    })

    it('keeps the home bench player when the visitors default leads off with a placeholder', async function () {
      const store = new HashedLineupStore()
      const session = await ScoringSession.open(store, 'g1', context, {
        ...new Clock().options,
        requireCurrentSetup: true
      })
      const blind = setupOf(session.state)
      expect(
        session.apply({
          type: 'lineup',
          kind: 'roster',
          setup: blind,
          unseen: ['away'],
          confirmed: ['home']
        }).problems
      ).deep.equals([])
      await session.flush()
      await coachPosts(store, addHomeBench)
      const server = setupOf((await open(store)).session.state)
      const bench = server.sides.home.players.find(
        id => !blind.sides.home.players.includes(id)
      )
      expect(bench).a('number')
      const shown = setupOf(session.state)
      const draft = {
        gameData: { teams: TEAMS, players: shown.players },
        liveData: { boxscore: { teams: shown.sides } },
        meta: { tagOrder: shown.tagOrder }
      }
      const guest = addPlayer(draft, 'away', 9000000, 'Guest', '0')
      expect(guest).not.equals(bench)
      const order = [...shown.sides.away.battingOrder]
      order[0] = guest
      shown.sides.away.battingOrder = order
      expect(
        session.apply({
          type: 'lineup',
          kind: 'roster',
          setup: shown,
          confirmed: ['away'],
          shown: true
        }).problems
      ).deep.equals([])
      expect(session.apply(ball).problems).deep.equals([])
      await session.flush()
      expect(store.refused).equals(1)
      expect(session.rebases).equals(1)
      expect(session.problem).equals(null)
      const lead = setupOf(session.state).sides.away.battingOrder[0]
      expect(lead).not.equals(bench)
      expect(session.state.gameData.players[lead].fullName).equals('Guest')
      expect(session.state.gameData.players[bench!].fullName).equals(
        'Home Bench'
      )
      expect(session.state.liveData.boxscore.teams.home.players).includes(bench)
      expect(
        session.state.liveData.boxscore.teams.away.battingOrder
      ).not.includes(bench)
      expect(
        session.state.liveData.plays.currentPlay?.matchup.batter.id
      ).equals(lead)
      const stored = (await open(store)).session
      expect(stored.state.gameData.players[bench!].fullName).equals(
        'Home Bench'
      )
      expect(stored.state.liveData.plays.currentPlay?.matchup.batter.id).equals(
        lead
      )
      expect(stored.state.gameData.players[lead].fullName).equals('Guest')
    })

    it('keeps a courtesy runner on base when the in-flight pitch was built before him', async function () {
      const store = new HashedLineupStore()
      const scored = await ScoringSession.open(store, 'g1', context, {
        ...new Clock().options
      })
      expect(
        scored.apply({ type: 'result', eventType: 'single' }).problems
      ).deep.equals([])
      await scored.flush()
      await coachPosts(store, addAwayBench)
      const session = await ScoringSession.open(store, 'g1', context, {
        ...new Clock().options
      })
      const onFirst = baseIds(session.state)[0]
      const bench = session.state.liveData.boxscore.teams.away.players.find(
        id => session.state.gameData.players[id]?.fullName === 'Away Bench'
      )
      expect(onFirst).a('number')
      expect(bench).a('number')
      expect(bench).not.equals(onFirst)
      const order = [...setupOf(session.state).sides.away.battingOrder]
      const defense = setupOf(session.state).sides.away.defense
      const before = store.lineups
      expect(session.apply(ball).problems).deep.equals([])
      const coach = (await open(store)).session
      const runner: ScoringAction = {
        type: 'lineup',
        kind: 'runner',
        side: 'away',
        base: '1B',
        player: bench!
      }
      expect(coach.apply(runner).problems).deep.equals([])
      await coach.flush()
      const read = readLineups(
        {
          plays: [...store.plays.values()].map(row => row.play),
          currentPlay: store.current
        },
        context
      )
      expect(lineupsDigest(read.sides, read.bench)).equals(before)
      expect(store.lineups).equals(
        lineupsDigest(read.sides, read.bench, read.courtesy)
      )
      expect(store.lineups).not.equals(before)
      expect(read.courtesy).length(1)
      expect([
        ...read.sides.away.changes,
        ...read.sides.home.changes
      ]).deep.equals([])
      expect(setupOf(session.state).sides.away.battingOrder).deep.equals(order)
      await session.flush()
      expect(store.refused).equals(1)
      expect(session.rebases).equals(1)
      expect(session.problem).equals(null)
      expect(baseIds(session.state)[0]).equals(bench)
      expect(session.state.gameData.players[bench!].fullName).equals(
        'Away Bench'
      )
      expect(setupOf(session.state).sides.away.battingOrder).deep.equals(order)
      expect(setupOf(session.state).sides.away.defense).deep.equals(defense)
      expect(session.state.liveData.plays.currentPlay?.count).includes({
        balls: 1,
        strikes: 0
      })
      const stored = (await open(store)).session
      expect(baseIds(stored.state)[0]).equals(bench)
      expect(stored.state.gameData.players[bench!].fullName).equals(
        'Away Bench'
      )
      expect(stored.state.liveData.plays.currentPlay?.count).includes({
        balls: 1,
        strikes: 0
      })
    })

    it('keeps the chosen next batter at the plate when the in-flight pitch was built before that save', async function () {
      const store = new HashedLineupStore()
      const session = await ScoringSession.open(store, 'g1', context, {
        ...new Clock().options
      })
      const closePlay: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
      for (let walks = 0; walks < 3; walks++) {
        for (let thrown = 0; thrown < 4; thrown++)
          expect(session.apply(ball).problems).deep.equals([])
        expect(session.apply(closePlay).problems).deep.equals([])
      }
      expect(
        session.apply({
          type: 'lineup',
          kind: 'battingOrder',
          side: 'away',
          order: [4, 1, 2, 3, 5, 6, 7, 8, 9]
        }).problems
      ).deep.equals([])
      await session.flush()
      expect(session.state.liveData.linescore.offense.batter?.id).equals(4)
      expect(session.apply(ball).problems).deep.equals([])
      const other = (await open(store)).session
      for (let thrown = 0; thrown < 3; thrown++)
        expect(other.apply(strike).problems).deep.equals([])
      expect(other.apply(closePlay).problems).deep.equals([])
      await other.flush()
      expect(other.state.awaitingBatter?.duePlayerId).equals(1)
      const before = store.lineups
      const storedGame = (): {
        plays: GumboPlay[]
        currentPlay: CurrentPlay | null
      } => ({
        plays: [...store.plays.values()].map(row => row.play),
        currentPlay: store.current
      })
      const readBefore = readLineups(storedGame(), context)
      const server = setupOf(other.state)
      const coach = (await open(store)).session
      const chosen = 5
      expect(
        coach.apply({
          type: 'lineup',
          kind: 'roster',
          setup: setupOf(coach.state),
          nextBatter: chosen
        }).problems
      ).deep.equals([])
      await coach.flush()
      const read = readLineups(storedGame(), context)
      expect(readBefore.due?.awaiting).equals(true)
      expect(read.due).deep.equals({
        awaiting: false,
        player: {
          gumboId: chosen,
          name: session.state.gameData.players[chosen].fullName,
          jersey: session.state.gameData.players[chosen].jersey
        }
      })
      expect(lineupsDigest(read.sides, read.bench, read.courtesy)).equals(
        lineupsDigest(readBefore.sides, readBefore.bench, readBefore.courtesy)
      )
      expect(store.lineups).equals(
        lineupsDigest(read.sides, read.bench, read.courtesy, read.due)
      )
      expect(store.lineups).not.equals(before)
      const after = setupOf((await open(store)).session.state)
      expect(after.sides.away.battingOrder).deep.equals(
        server.sides.away.battingOrder
      )
      expect(after.sides.away.defense).deep.equals(server.sides.away.defense)
      await session.flush()
      expect(store.refused).equals(1)
      expect(session.rebases).equals(1)
      expect(session.problem).equals(null)
      expect(session.state.liveData.linescore.offense.batter?.id).equals(chosen)
      expect(session.state.liveData.plays.currentPlay?.count).includes({
        balls: 1,
        strikes: 0
      })
      const stored = (await open(store)).session
      expect(stored.state.liveData.linescore.offense.batter?.id).equals(chosen)
      expect(stored.state.liveData.plays.currentPlay?.count).includes({
        balls: 1,
        strikes: 0
      })
    })

    it('replays a roster saved from the sheet over the coach order', async function () {
      const store = new LineupStore()
      const { session } = await open(store)
      const blind = setupOf(session.state)
      const placeholder: ScoringAction = {
        type: 'lineup',
        kind: 'roster',
        setup: blind,
        unseen: ['away'],
        confirmed: ['home']
      }
      expect(session.apply(placeholder).problems).deep.equals([])
      await session.flush()
      const coachRoster = await coachSaves(store, swapAwayLeadoff)
      const sheet = setupOf(session.state)
      reverseAway(sheet)
      const roster: ScoringAction = {
        type: 'lineup',
        kind: 'roster',
        setup: sheet,
        confirmed: ['away', 'home']
      }
      expect(session.apply(roster).problems).deep.equals([])
      await session.flush()
      expect(store.refused).equals(1)
      expect(session.rebases).equals(1)
      expect(session.problem).equals(null)
      expect(session.actions).deep.equals([placeholder, coachRoster, roster])
      expect(setupOf(session.state).sides.away.battingOrder).deep.equals(
        sheet.sides.away.battingOrder
      )
    })

    it('puts an undo of its own saved pitch under the coach’s change', async function () {
      const store = new LineupStore()
      const { session } = await open(store)
      session.apply(ball)
      session.apply(strike)
      await session.flush()
      const roster = await coachSaves(store, swapLeadoff)
      session.undo()
      session.apply(ball)
      await session.flush()
      expect(session.actions).deep.equals([ball, roster, ball])
      expect((await open(store)).session.actions).deep.equals([
        ball,
        roster,
        ball
      ])
    })

    it('keeps trying, never read-only, while the lineups keep moving', async function () {
      const store = new LineupStore()
      const { session, clock } = await open(store)
      const load = store.load.bind(store)
      store.load = async () => {
        const read = await load()
        store.lineups = `${store.lineups}+`
        return read
      }
      store.lineups = 'moved'
      session.apply(ball)
      await session.flush()
      expect(store.refused).equals(4)
      expect(session.readOnly).equals(false)
      expect(session.problem).equals(
        'Somebody else changed the lineups since this game was read'
      )
      expect(session.actions).deep.equals([ball])
      expect(clock.waiting.map(entry => entry.ms)).deep.equals([1000])
      store.load = load
      await clock.tick()
      expect(session.problem).equals(null)
      expect(session.pending).equals(0)
    })

    it('goes read-only when the read it takes up cannot be read back', async function () {
      const store = new LineupStore()
      const { session } = await open(store)
      session.apply(ball)
      await session.flush()
      store.lineups = 'moved'
      const load = store.load.bind(store)
      store.load = async () => {
        throw new HttpError('forbidden', 'Not yours')
      }
      session.apply(strike)
      await session.flush()
      expect(session.readOnly).equals(true)
      expect(session.problem).equals('Not yours')
      store.load = load
    })
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
      player: 19,
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

  describe('a game swapped under it', function () {
    /** The server after a swap: the record on its new sides, and a context. */
    class SwappingStore extends FakeStore {
      context: SessionContext | undefined
      staleOnce = false

      override async load(): Promise<StoredGame> {
        const stored = await super.load()
        return this.context == null
          ? stored
          : { ...stored, context: this.context }
      }

      override async save(
        gameId: string,
        change: SaveChange
      ): Promise<StoredGame> {
        if (this.staleOnce) {
          this.staleOnce = false
          throw new HttpError('conflict', 'Somebody else changed the lineups', {
            stale: true
          })
        }
        return await super.save(gameId, change)
      }

      swap(): void {
        this.current = {
          ...this.current!,
          teamStation: (this.current as { teamStation?: unknown }).teamStation
        }
        this.context = {
          ...context,
          teams: { home: TEAMS.away, away: TEAMS.home },
          setup: {
            ...context.setup,
            sides: {
              home: context.setup.sides.away,
              away: context.setup.sides.home
            }
          }
        }
      }
    }
    const roster: ScoringAction = {
      type: 'lineup',
      kind: 'roster',
      setup: setupOf(game()),
      confirmed: ['away', 'home']
    }

    it('reloads on the context its store gives, and keeps it', async function () {
      const store = new SwappingStore()
      const { session } = await open(store)
      session.apply(roster)
      await session.flush()
      store.swap()
      expect(await session.reload()).equals(true)
      expect(session.readOnly).equals(false)
      expect(session.state.gameData.teams.home.id).equals(TEAMS.away.id)
      expect(session.state.liveData.linescore.offense.batter?.id).equals(10)
      // The store gives no context on the next read: the one it gave holds.
      store.context = undefined
      await session.reload()
      expect(session.readOnly).equals(false)
      expect(session.state.gameData.teams.home.id).equals(TEAMS.away.id)
    })

    it('reloads on the context it was opened with when its store gives none, its record read by team', async function () {
      const store = new SwappingStore()
      const { session } = await open(store)
      session.apply(roster)
      await session.flush()
      store.swap()
      store.context = undefined
      await session.reload()
      expect(session.state.gameData.teams.home.id).equals(TEAMS.home.id)
      expect(session.problem).equals(null)
      expect(session.readOnly).equals(false)
    })

    it('rebases on the context its store gives after a stale save, dropping its own actions from before the swap', async function () {
      const store = new SwappingStore()
      const { session } = await open(store)
      session.apply(roster)
      await session.flush()
      store.swap()
      store.staleOnce = true
      expect(session.apply(ball).problems).deep.equals([])
      await session.flush()
      expect(session.readOnly).equals(false)
      expect(session.state.gameData.teams.home.id).equals(TEAMS.away.id)
      // The ball was thrown at the old sides: it is not put back, and the
      // scorer is told.
      expect(session.problem).equals(
        'Home and away were swapped, so a change not yet saved before the swap was not kept.'
      )
      expect(store.current?.playEvents).deep.equals([])
      expect(session.state.liveData.linescore.offense.batter?.id).equals(10)
    })
  })
})
