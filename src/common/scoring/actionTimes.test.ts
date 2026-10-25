import { expect } from 'chai'
import { describe, it } from 'mocha'

import { game, TEAMS } from '../../test/scoringGames'
import { HttpError } from '../errors'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { PitchCall, ScoringAction } from './actions'
import { keyOf, matchTimes, REPLACED_KEEPS_TIME_MS } from './actionTimes'
import { applyAction } from './apply'
import { comparablePlay } from './comparable'
import { storedRecordOf } from './gumbo'
import { forPlayback } from './playbackTimes'
import {
  type EventStore,
  type SaveChange,
  ScoringSession,
  type StoredGame
} from './session'
import { setupOf } from './state'

/** A server in memory, which can be made to refuse. */
class Store implements EventStore {
  plays = new Map<number, GumboPlay>()
  current: CurrentPlay | null = null
  fail: HttpError | null = null

  async load(): Promise<StoredGame> {
    return {
      plays: JSON.parse(JSON.stringify([...this.plays.values()])),
      currentPlay: JSON.parse(JSON.stringify(this.current))
    }
  }

  async save(_gameId: string, change: SaveChange): Promise<StoredGame> {
    if (this.fail != null) throw this.fail
    for (const index of change.remove) this.plays.delete(index)
    for (const play of change.plays) this.plays.set(play.about.atBatIndex, play)
    if (change.currentPlay !== undefined) this.current = change.currentPlay
    return await this.load()
  }
}

const START = Date.parse('2026-09-25T12:00:00Z')

/** The session's clock, moved by hand; timers wait for `flush`. */
class Clock {
  ms = START
  options = {
    now: () => new Date(this.ms),
    setTimer: () => null,
    clearTimer: () => undefined
  }

  /** Moves on, and says the time it is now. */
  pass(seconds: number): string {
    this.ms += seconds * 1000
    return this.iso()
  }

  iso(): string {
    return new Date(this.ms).toISOString()
  }
}

const context = { gamePk: 'g1', teams: TEAMS, setup: setupOf(game()) }
const pitch = (call: PitchCall): ScoringAction => ({ type: 'pitch', call })
const ball = pitch('B')
const strike = pitch('C')
const foul = pitch('F')
const single: ScoringAction = { type: 'result', eventType: 'single' }

describe('canonical radar timing categories', () => {
  const dropped: ScoringAction = { type: 'result', eventType: 'strikeout' }
  const inPlay: ScoringAction = { type: 'ballInPlay', contact: 'swing' }
  const oldTime = new Date(START).toISOString()
  const newTime = new Date(START + 30000).toISOString()
  for (const [from, to, retained] of [
    [dropped, pitch('S'), true],
    [pitch('S'), dropped, true],
    [dropped, single, false],
    [single, dropped, false],
    [single, inPlay, true],
    [inPlay, single, true],
    [single, { type: 'result', eventType: 'double' }, true],
    [dropped, { type: 'result', eventType: 'hit_by_pitch' }, false]
  ] as Array<[ScoringAction, ScoringAction, boolean]>)
    it(`${keyOf(from)} to ${keyOf(to)} ${retained ? 'retains' : 'replaces'} its time`, () => {
      expect(
        matchTimes(
          [keyOf(to)],
          [newTime],
          {
            keys: [keyOf(from)],
            times: [oldTime],
            cutAt: [newTime],
            cut: 1
          },
          undefined,
          1
        ).times
      ).deep.equals([retained ? oldTime : newTime])
    })
})

async function open(
  store = new Store(),
  clock = new Clock()
): Promise<{ session: ScoringSession; store: Store; clock: Clock }> {
  const session = await ScoringSession.open(store, 'g1', context, clock.options)
  return { session, store, clock }
}

describe('separate scoring and radar clocks', () => {
  it('persists the original completed-play clock when a subscriber caches a correction', async () => {
    const { session, store, clock } = await open()
    session.subscribe(() => session.picture())
    const times: string[] = []
    for (const action of [strike, strike, strike, ball]) {
      times.push(clock.iso())
      session.apply(action)
      clock.pass(20)
    }
    await session.flush()
    const corrected = clock.pass(600)
    expect(session.sync([strike, strike, single, ball])).deep.equals([])
    const completed = [...session.picture().plays.values()][0]
    expect(storedRecordOf(completed)!.actionTimes).deep.equals([
      ...times.slice(0, 2),
      corrected
    ])
    expect(storedRecordOf(forPlayback(completed))!.actionTimes).deep.equals(
      times.slice(0, 3)
    )
    await session.flush()
    expect(
      storedRecordOf(forPlayback(store.plays.get(0)))!.actionTimes
    ).deep.equals(times.slice(0, 3))
    const reopened = (await open(store, clock)).session
    expect(
      storedRecordOf(forPlayback([...reopened.picture().plays.values()][0]))!
        .actionTimes
    ).deep.equals(times.slice(0, 3))
  })

  for (const call of ['B', 'C', 'F'] as const)
    for (const delay of [20, 180])
      it(`keeps a new ${call} pitch time after an unsaved quick Undo and ${delay}s delay`, async () => {
        const { session, store, clock } = await open()
        session.apply(ball)
        await session.flush()
        clock.pass(10)
        session.undo()
        const entered = clock.pass(delay)
        session.apply(pitch(call))
        await session.flush()
        expect(storedRecordOf(store.current)!.actionTimes).deep.equals([
          entered
        ])
        expect(
          storedRecordOf(forPlayback(store.current))!.actionTimes
        ).deep.equals([entered])
      })

  for (const saveFirst of [false, true])
    it(`preserves corrections through buffering, reload and rejected saves, initial save ${saveFirst}`, async () => {
      const { session, store, clock } = await open()
      const times: string[] = []
      for (const action of [ball, strike, foul]) {
        times.push(clock.iso())
        session.apply(action)
        clock.pass(20)
      }
      if (saveFirst) await session.flush()
      const corrected = clock.pass(600)
      expect(session.sync([foul, strike, foul])).deep.equals([])
      await session.flush()
      expect(storedRecordOf(store.current)!.actionTimes).deep.equals([
        corrected,
        ...times.slice(1)
      ])
      expect(
        storedRecordOf(forPlayback(store.current))!.actionTimes
      ).deep.equals(times)
      const reopened = (await open(store, clock)).session
      expect(
        storedRecordOf(forPlayback(reopened.picture().current))!.actionTimes
      ).deep.equals(times)
      clock.pass(120)
      reopened.apply(ball)
      store.fail = new HttpError('conflict', 'Scoring changed elsewhere')
      await reopened.flush()
      expect(
        storedRecordOf(forPlayback(reopened.picture().current))!.actionTimes
      ).deep.equals(times)
      expect(
        storedRecordOf(reopened.picture().current)!.actionTimes
      ).deep.equals([corrected, ...times.slice(1)])
    })
})

/** The documents the session would store, in game order. */
function documents(session: ScoringSession): GumboPlay[] {
  const picture = session.picture()
  return [
    ...picture.plays.values(),
    ...(picture.current == null
      ? []
      : [picture.current as unknown as GumboPlay])
  ].sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
}

/** Every action's time, read back from the documents the session stores. */
function timesOf(session: ScoringSession): string[] {
  return documents(session).flatMap(document => {
    const record = storedRecordOf(document)!
    if (record.actions.length === 0) return []
    expect(record.actionTimes, `play ${document.about.atBatIndex}`).length(
      record.actions.length
    )
    return record.actionTimes!
  })
}

/** Applies one action a second, from a second after the clock reads. */
function score(
  session: ScoringSession,
  clock: Clock,
  actions: ScoringAction[]
): string[] {
  return actions.map(action => {
    const at = clock.pass(1)
    expect(session.apply(action).problems, JSON.stringify(action)).deep.equals(
      []
    )
    return at
  })
}

/**
 * 300 pitches: each batter takes two balls, a called strike, three fouls and
 * strikes out swinging, so no game ends inside them and a changed pitch only
 * moves the count.
 */
function longGame(): ScoringAction[] {
  const pattern: PitchCall[] = ['B', 'B', 'C', 'F', 'F', 'F', 'S']
  const actions = Array.from({ length: 300 }, (_, i) =>
    pitch(pattern[i % pattern.length])
  )
  let state = game()
  for (const action of actions) {
    const applied = applyAction(state, action)
    expect(applied.problems).deep.equals([])
    state = applied.state
  }
  return actions
}

describe('an action’s key', function () {
  it('is the same for two that say the same, whatever order their keys are in', function () {
    const listed = {
      type: 'pitch',
      call: 'X',
      location: { x: 1, y: 2 }
    } as unknown as ScoringAction
    const readBack = {
      location: { y: 2, x: 1 },
      call: 'X',
      type: 'pitch'
    } as unknown as ScoringAction
    expect(keyOf(readBack)).equals(keyOf(listed))
    expect(keyOf({ type: 'pitch', call: 'B' })).not.equals(
      keyOf({ type: 'pitch', call: 'C' })
    )
  })
})

describe('the time each scoring action was taken', function () {
  it('stamps every action with the session clock, and a folded play carries one time per action (U1)', async function () {
    const { session, clock } = await open()
    const times = score(session, clock, [ball, single, ball])
    const [first, second] = documents(session)
    expect(first.about.atBatIndex).equals(0)
    expect(storedRecordOf(first)).deep.include({
      actions: [ball, single],
      actionTimes: times.slice(0, 2)
    })
    expect(storedRecordOf(second)).deep.include({
      actions: [ball],
      actionTimes: times.slice(2)
    })
    expect(timesOf(session)).deep.equals(times)
  })

  it('undoes a time with its action, keeps stored times through a reload and stamps only new actions (U2)', async function () {
    const { session, store, clock } = await open()
    const times = score(session, clock, [ball, strike])
    session.undo()
    expect(timesOf(session)).deep.equals(times.slice(0, 1))
    const fouled = score(session, clock, [foul])
    expect(timesOf(session)).deep.equals([times[0], ...fouled])
    await session.flush()

    clock.pass(3600)
    const again = await open(store, clock)
    expect(again.session.actions).deep.equals([ball, foul])
    expect(timesOf(again.session)).deep.equals([times[0], ...fouled])
    const next = score(again.session, clock, [strike])
    expect(timesOf(again.session)).deep.equals([times[0], ...fouled, ...next])
  })

  it('goes back to the saved times with the saved log when a save is refused (U2)', async function () {
    const { session, store, clock } = await open()
    const times = score(session, clock, [ball, strike])
    await session.flush()
    session.undo()
    session.undo()
    score(session, clock, [foul])
    store.fail = new HttpError('conflict', 'Somebody else is scoring')
    await session.flush()
    expect(session.readOnly).equals(true)
    expect(session.actions).deep.equals([ball, strike])
    expect(timesOf(session)).deep.equals(times)
  })

  it('writes a play holding an action with no time without times (U2)', async function () {
    const old = await open()
    old.session.apply(ball)
    await old.session.flush()
    // A play scored before actions carried times.
    delete (old.store.current!.teamStation as { actionTimes?: unknown })
      .actionTimes
    const { session, clock } = await open(old.store)
    score(session, clock, [strike, single])
    const [reopened] = documents(session)
    expect(storedRecordOf(reopened)?.actions).deep.equals([
      ball,
      strike,
      single
    ])
    expect(storedRecordOf(reopened)).not.have.property('actionTimes')
    const next = score(session, clock, [ball])
    expect(storedRecordOf(documents(session)[1])?.actionTimes).deep.equals(next)
  })

  it('reads a record whose times do not match its actions as one without times (U3)', function () {
    const record = {
      version: 2,
      setupBefore: setupOf(game()),
      actions: [ball, strike]
    }
    const read = (actionTimes?: unknown): unknown =>
      storedRecordOf({ teamStation: { ...record, actionTimes } })
    const plain = storedRecordOf({ teamStation: record })
    expect(plain).not.have.property('actionTimes')
    expect(plain?.actions).deep.equals([ball, strike])
    for (const wrong of [
      ['2026-09-25T12:00:01.000Z'],
      ['2026-09-25T12:00:01.000Z', 7],
      'soon'
    ])
      expect(read(wrong)).deep.equals(plain)
    const times = ['2026-09-25T12:00:01.000Z', '2026-09-25T12:00:02.000Z']
    expect(read(times)).deep.equals({ ...plain, actionTimes: times })
  })

  it('compares two plays without their action times (U4)', async function () {
    const { session, clock } = await open()
    score(session, clock, [ball, single, ball])
    const [timed] = documents(session)
    const untimed = JSON.parse(JSON.stringify(timed)) as GumboPlay
    delete (untimed.teamStation as { actionTimes?: unknown }).actionTimes
    expect(storedRecordOf(timed)?.actionTimes).length(2)
    expect(comparablePlay(timed)).deep.equals(comparablePlay(untimed))
  })

  it('keeps every time through a sync that corrects pitch 50 of 300 two hours later (U40)', async function () {
    const { session, clock } = await open()
    const scored = longGame()
    const times = score(session, clock, scored)
    expect(timesOf(session)).deep.equals(times)

    const now = clock.pass(2 * 3600)
    const target = [...scored]
    // Pitch 50, a ball, becomes a called strike; a foul tip goes in after
    // pitch 101; pitch 199, a called strike, comes out; a ball goes on the end.
    target[49] = strike
    target.splice(101, 0, pitch('T'))
    target.splice(199, 1)
    target.push(ball)
    expect(session.sync(target)).deep.equals([])
    expect(session.actions).deep.equals(target)
    expect(timesOf(session)).deep.equals([
      ...times.slice(0, 101),
      // The inserted pitch, at the time of the pitch before it.
      times[100],
      ...times.slice(101, 198),
      ...times.slice(199),
      now
    ])
  })

  for (const spacing of [10, 25, 40])
    it(`keeps the times of the pitches a sync puts back after correcting one on the spot, ${spacing} s apart`, async function () {
      const { session, clock } = await open()
      const times = [ball, strike, foul].map(action => {
        const at = clock.iso()
        expect(session.apply(action).problems).deep.equals([])
        clock.pass(spacing)
        return at
      })
      // The screen changes the first pitch and applies its history again.
      expect(session.sync([strike, strike, foul])).deep.equals([])
      // Every pitch keeps its moment, the changed one too: it happened when
      // the pitch it replaced did.
      expect(timesOf(session)).deep.equals(times)
      // A pitch after them, in a later call, is new and moves none of them.
      const [next] = score(session, clock, [ball])
      expect(timesOf(session)).deep.equals([...times, next])
    })

  it('puts back only what the cutting sync itself applied at its own time when recent', async function () {
    const { session, clock } = await open()
    const times = score(session, clock, [ball, strike, foul])
    clock.pass(5)
    // A sync that cuts back and applies nothing ...
    expect(session.sync([ball])).deep.equals([])
    // ... and a later one that enters the same pitches again: they are new.
    clock.pass(5)
    const now = clock.iso()
    expect(session.sync([ball, strike, foul])).deep.equals([])
    expect(timesOf(session)).deep.equals([times[0], now, now])
    // Unchanged history keeps its time, but ball-to-foul uses the correction
    // time and radar window; the foul an Undo took off at once was
    // let go, so entered again it is a new pitch.
    session.undo()
    clock.pass(5)
    const later = clock.iso()
    expect(session.sync([foul, strike, foul])).deep.equals([])
    expect(timesOf(session)).deep.equals([later, now, later])
  })

  it('stamps a pitch recorded within a minute of the one an Undo took off now, whatever its call (U41)', async function () {
    const { session, clock } = await open()
    const [first, undone] = score(session, clock, [ball, ball])
    clock.pass(5)
    session.undo()
    const [replaced] = score(session, clock, [strike])
    expect(timesOf(session)).deep.equals([first, replaced])

    clock.pass(20)
    session.undo()
    const [later] = score(session, clock, [foul])
    expect(timesOf(session)).deep.equals([first, later])

    // The same call again within a minute is a new pitch too.
    session.undo()
    const [again] = score(session, clock, [foul])
    expect(timesOf(session)).deep.equals([first, again])
    expect(undone).not.equals(later)
    expect(later).not.equals(again)
  })

  it('stamps a real pitch after an accidental one was undone now, though its call is the same (U41)', async function () {
    const { session, clock } = await open()
    const [first] = score(session, clock, [strike])
    const accidental = clock.pass(10)
    session.apply(ball)
    clock.pass(3)
    session.undo()
    const real = clock.pass(22)
    session.apply(ball)
    expect(timesOf(session)).deep.equals([first, real])
    expect(real).not.equals(accidental)
  })

  it('stamps a pitch now when the one an Undo took off was undone within a minute, however long until it (U41)', async function () {
    const { session, clock } = await open()
    const [first] = score(session, clock, [strike])
    const mistaken = clock.pass(10)
    session.apply(ball)
    clock.pass(3)
    session.undo()
    // The real first pitch after a break, a minute and a half later.
    const real = clock.pass(90)
    session.apply(strike)
    expect(timesOf(session)).deep.equals([first, real])
    expect(real).not.equals(mistaken)
  })

  it('stamps a pitch now when a screen’s sync took the one before it off within a minute, however long until it (U41)', async function () {
    const { session, clock } = await open()
    const [first] = score(session, clock, [strike])
    clock.pass(10)
    expect(session.sync([strike, ball])).deep.equals([])
    clock.pass(3)
    // The screen's Undo: a sync that only cuts.
    expect(session.sync([strike])).deep.equals([])
    const real = clock.pass(90)
    expect(session.sync([strike, strike])).deep.equals([])
    expect(timesOf(session)).deep.equals([first, real])
  })

  for (const [how, takeBack] of [
    ['an Undo', (session: ScoringSession) => session.undo().problems],
    ['a screen’s sync', (session: ScoringSession) => session.sync([strike])]
  ] as const)
    it(`keeps a real pitch’s own time when the one after it has the call of a pitch ${how} took off within a minute`, async function () {
      const { session, clock } = await open()
      const [first] = score(session, clock, [strike])
      clock.pass(10)
      expect(session.apply(ball).problems).deep.equals([])
      clock.pass(3)
      expect(takeBack(session)).deep.equals([])
      // The real strike, after a break, and a ball ten seconds after it: the
      // ball is not the mistaken one put back, so the strike was not put in
      // ahead of it.
      const real = clock.pass(90)
      expect(session.apply(strike).problems).deep.equals([])
      const next = clock.pass(10)
      expect(session.apply(ball).problems).deep.equals([])
      expect(timesOf(session)).deep.equals([first, real, next])
    })

  for (const [how, takeBack] of [
    ['at once', (session: ScoringSession) => session.sync([])],
    [
      'one at a time',
      (session: ScoringSession) =>
        [1, 2, 3].flatMap(() => session.undo().problems)
    ]
  ] as const)
    it(`lets go the pitches a cut of several ${how} took off within a minute, and keeps the older ones`, async function () {
      const { session, clock } = await open()
      const times = score(session, clock, [ball, strike])
      clock.pass(100)
      score(session, clock, [foul])
      clock.pass(5)
      // The ball and the strike were over a minute old when they were cut,
      // the foul five seconds.
      expect(takeBack(session)).deep.equals([])
      clock.pass(90)
      expect(session.sync([ball, strike])).deep.equals([])
      expect(timesOf(session)).deep.equals(times)
      // A new ball, then a foul: the foul is not the one cut, so the ball
      // was not put in ahead of it and keeps its own time.
      const later = score(session, clock, [ball, foul])
      expect(timesOf(session)).deep.equals([...times, ...later])
    })

  it('gives a pitch entered right after an Undo two minutes on the undone pitch’s time', async function () {
    const { session, clock } = await open()
    const [first, wrong] = score(session, clock, [strike, ball])
    clock.pass(120)
    session.undo()
    // The ball was a called strike: the correction goes back to its moment.
    score(session, clock, [strike])
    expect(timesOf(session)).deep.equals([first, wrong])
    // Entered again unchanged, it does too.
    clock.pass(5)
    session.undo()
    score(session, clock, [strike])
    expect(timesOf(session)).deep.equals([first, wrong])
  })

  it('keeps the time of a pitch put back unchanged more than a minute after it was taken', async function () {
    const { session, clock } = await open()
    const times = score(session, clock, [ball, strike])
    clock.pass(90)
    session.undo()
    session.undo()
    score(session, clock, [ball, strike])
    expect(timesOf(session)).deep.equals(times)
  })

  it('lets what an Undo displaced go when the game is read again (U41)', async function () {
    const { session, store, clock } = await open()
    const [first] = score(session, clock, [ball])
    await session.flush()
    clock.pass(2 * 3600)
    session.undo()
    await session.flush()
    // Somebody else scores the pitch meanwhile.
    const other = await open(store, clock)
    const [theirs] = score(other.session, clock, [strike])
    await other.session.flush()
    expect(await session.reload()).equals(true)
    // Without the reload, this would take the undone ball's two-hour-old time.
    const [mine] = score(session, clock, [foul])
    expect(first).not.equals(mine)
    expect(timesOf(session)).deep.equals([theirs, mine])
  })

  it('carries the times of actions undone in several steps, and lets them go once past them', async function () {
    const { session, clock } = await open()
    const times = score(session, clock, [ball, strike, foul, ball])
    clock.pass(120)
    session.undo()
    session.undo()
    session.undo()
    // The strike becomes a foul. Alone, the foul is the foul it equals, and
    // the strike was deleted ...
    const [correction] = score(session, clock, [foul])
    expect(timesOf(session)).deep.equals([times[0], times[2]])
    // ... until the foul after it shows it took the strike's place.
    score(session, clock, [foul])
    times[1] = correction
    expect(timesOf(session)).deep.equals(times.slice(0, 3))
    // Undo again, part way: what it took joins what is still displaced.
    session.undo()
    score(session, clock, [foul, ball])
    expect(timesOf(session)).deep.equals(times)
    const [beyond] = score(session, clock, [ball])
    const [after] = score(session, clock, [strike])
    expect(timesOf(session)).deep.equals([...times, beyond, after])
  })

  for (const [how, takeBack] of [
    ['an Undo', (session: ScoringSession) => session.undo().problems],
    [
      'a screen’s sync',
      (session: ScoringSession) => session.sync(session.actions.slice(0, -1))
    ]
  ] as const)
    it(`keeps the times of history a sync corrects while pitches ${how} took off two minutes on are still held`, async function () {
      const { session, clock } = await open()
      // Pitches 20 s apart, from 12:00:20 to 12:02:00.
      const times = [foul, strike, strike, foul, strike, foul].map(action => {
        const at = clock.pass(20)
        expect(session.apply(action).problems).deep.equals([])
        return at
      })
      expect(times[0]).equals('2026-09-25T12:00:20.000Z')
      expect(times[5]).equals('2026-09-25T12:02:00.000Z')
      clock.pass(120)
      expect([...takeBack(session), ...takeBack(session)]).deep.equals([])
      expect(timesOf(session)).deep.equals(times.slice(0, 4))
      // Changing strike to foul selects a new radar window. Every unchanged
      // pitch keeps its old time rather than shifting onto the held pitches.
      expect(session.sync([foul, foul, strike, foul])).deep.equals([])
      times[1] = clock.iso()
      expect(timesOf(session)).deep.equals(times.slice(0, 4))
      // The pitches still held are there for a later correction.
      score(session, clock, [strike, foul])
      expect(timesOf(session)).deep.equals(times)
    })

  it('keeps the times of history a sync corrects while actions without times are held', async function () {
    const old = await open()
    const times = score(old.session, old.clock, [ball, strike, single])
    score(old.session, old.clock, [strike, single])
    await old.session.flush()
    // The second play was scored before actions carried times.
    delete (old.store.current!.teamStation as { actionTimes?: unknown })
      .actionTimes
    const { session, clock } = await open(old.store, old.clock)
    clock.pass(120)
    session.undo()
    session.undo()
    expect(timesOf(session)).deep.equals(times)
    // The first pitch was a called strike: the play corrected keeps its
    // times, none of them taken from the held actions that have none.
    expect(session.sync([strike, strike, single])).deep.equals([])
    expect(timesOf(session)).deep.equals(times)
  })

  it('folds a finished play again when matching changes one of its times', async function () {
    const { session, clock } = await open()
    const times = score(session, clock, [ball, single, ball, ball])
    // A screen asks what is waiting to be saved after every action, which
    // folds the plays finished so far, before a sync has matched its run.
    session.subscribe(() => session.pending)
    clock.pass(2 * 3600)
    expect(session.sync([strike, single, ball, ball])).deep.equals([])
    expect(timesOf(session)).deep.equals(times)
  })

  it('gives an inserted action the time of the one before it, and the first the time before the cut', function () {
    const stamp = (n: number): string =>
      new Date(START + n * 1000).toISOString()
    const shown = {
      keys: ['a', 'b'],
      times: [stamp(1), stamp(2)],
      cutAt: [stamp(499), stamp(499)]
    }
    expect(
      matchTimes(
        ['x', 'a', 'b'],
        [stamp(500), stamp(501), stamp(502)],
        shown,
        stamp(0)
      )
    ).deep.equals({
      times: [stamp(0), stamp(1), stamp(2)],
      consumed: 2,
      past: false
    })
    expect(
      matchTimes(['x', 'a'], [stamp(500), stamp(501)], shown, undefined)
    ).deep.equals({ times: [stamp(500), stamp(1)], consumed: 1, past: false })
    // A displaced action with no time leaves the one replacing it its own.
    expect(
      matchTimes(
        ['y', 'b', 'c'],
        [stamp(500), stamp(501), stamp(502)],
        {
          keys: ['a', 'b'],
          times: [undefined, stamp(2)],
          cutAt: [stamp(499), stamp(499)]
        },
        undefined
      )
    ).deep.equals({
      times: [stamp(500), stamp(2), stamp(502)],
      consumed: 2,
      past: true
    })
    expect(REPLACED_KEEPS_TIME_MS).equals(60_000)
  })

  it('gives an action equal to a displaced one its time only when that was more than a minute old at the cut, and none when it had none', function () {
    const stamp = (n: number): string =>
      new Date(START + n * 1000).toISOString()
    const shown = {
      keys: ['a', 'b', 'c'],
      times: [stamp(1), stamp(30), undefined],
      cutAt: [stamp(62), stamp(62), stamp(62)]
    }
    expect(
      matchTimes(
        ['a', 'b', 'c'],
        [stamp(62), stamp(63), stamp(64)],
        shown,
        undefined
      ).times
    ).deep.equals([stamp(1), stamp(63), undefined])
    // The age is the action's when it was cut, not when the next one came:
    // cut 3 s after it was taken, a pitch lends nothing to one two minutes
    // later, and cut two minutes after, it lends its time to one at once.
    const quick = { keys: ['a'], times: [stamp(1)], cutAt: [stamp(4)] }
    expect(matchTimes(['b'], [stamp(124)], quick, undefined).times).deep.equals(
      [stamp(124)]
    )
    const late = { keys: ['a'], times: [stamp(1)], cutAt: [stamp(121)] }
    expect(matchTimes(['b'], [stamp(122)], late, undefined).times).deep.equals([
      stamp(1)
    ])
  })

  it('gives the actions the cutting call puts back the times of the ones it cut, whatever their age', function () {
    const stamp = (n: number): string =>
      new Date(START + n * 1000).toISOString()
    const shown = {
      keys: ['a', 'b', 'c'],
      times: [stamp(1), stamp(2), stamp(3)],
      cutAt: [stamp(9), stamp(9), stamp(9)],
      cut: 2
    }
    const stamped = [stamp(10), stamp(10), stamp(10)]
    // Applied in the cutting call: the two it cut keep theirs, the one left
    // from an earlier cut is matched by age.
    expect(
      matchTimes(['a', 'b', 'c'], stamped, shown, undefined, 3).times
    ).deep.equals([stamp(1), stamp(2), stamp(10)])
    // Applied in a later call, none of them.
    expect(
      matchTimes(['a', 'b', 'c'], stamped, shown, undefined, 1).times
    ).deep.equals([stamp(1), stamp(10), stamp(10)])
    // A changed action in the cutting call takes the time of the one it
    // replaced too, whatever its age; in a later call, by age.
    expect(
      matchTimes(['x', 'b'], stamped, shown, undefined, 2).times
    ).deep.equals([stamp(1), stamp(2)])
    expect(
      matchTimes(['x', 'b'], stamped, shown, undefined, 0).times
    ).deep.equals([stamp(10), stamp(10)])
  })

  it('matches the history the cutting call puts back only against what that cut took off, and what comes after it against the rest', function () {
    const stamp = (n: number): string =>
      new Date(START + n * 1000).toISOString()
    // This cut took off c, c, f; c and f are left over from an earlier one.
    const shown = {
      keys: ['c', 'c', 'f', 'c', 'f'],
      times: [stamp(40), stamp(60), stamp(80), stamp(100), stamp(120)],
      cutAt: [stamp(250), stamp(250), stamp(250), stamp(240), stamp(240)],
      cut: 3
    }
    const stamped = [stamp(250), stamp(250), stamp(250), stamp(251)]
    // Matched as one run, f c f would shift onto the leftovers' times.
    expect(
      matchTimes(['f', 'c', 'f'], stamped, shown, stamp(20), 3)
    ).deep.equals({
      times: [stamp(40), stamp(60), stamp(80)],
      consumed: 3,
      past: false
    })
    // An action after that history is matched against what is left.
    expect(
      matchTimes(['f', 'c', 'f', 'c'], stamped, shown, stamp(20), 3)
    ).deep.equals({
      times: [stamp(40), stamp(60), stamp(80), stamp(100)],
      consumed: 4,
      past: false
    })
    // So is one after history that used only part of the cut: the f the
    // history left goes before the leftovers.
    expect(
      matchTimes(['c', 'f', 'c'], stamped, shown, stamp(20), 1)
    ).deep.equals({
      times: [stamp(40), stamp(80), stamp(100)],
      consumed: 4,
      past: false
    })
  })

  it('matches a 300-action displaced tail in under 10 ms (U42)', function () {
    const scored = longGame()
    const keys = scored.map(keyOf)
    const times = keys.map((_, i) => new Date(START + i * 1000).toISOString())
    const applied = [...keys]
    applied[49] = keyOf(strike)
    const stamped = keys.map(() => new Date(START + 7200_000).toISOString())
    const shown = { keys, times, cutAt: stamped }
    matchTimes(applied, stamped, shown, undefined)
    const started = performance.now()
    const matched = matchTimes(applied, stamped, shown, undefined)
    const took = performance.now() - started
    expect(matched.times).deep.equals(times)
    expect(took).lessThan(10)
  })
})
