import { expect } from 'chai'
import { describe, it } from 'mocha'

import { game, TEAMS } from '../../test/scoringGames'
import { HttpError } from '../errors'
import type { CurrentPlay, GumboPlay } from '../gumboPlay'
import type { PitchCall, ScoringAction } from './actions'
import { keyOf, matchTimes, REPLACED_KEEPS_TIME_MS } from './actionTimes'
import { applyAction } from './apply'
import { comparablePlay } from './comparable'
import { recordOf } from './gumbo'
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

async function open(
  store = new Store(),
  clock = new Clock()
): Promise<{ session: ScoringSession; store: Store; clock: Clock }> {
  const session = await ScoringSession.open(store, 'g1', context, clock.options)
  return { session, store, clock }
}

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
    const record = recordOf(document)!
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

describe('the time each scoring action was taken', function () {
  it('stamps every action with the session clock, and a folded play carries one time per action (U1)', async function () {
    const { session, clock } = await open()
    const times = score(session, clock, [ball, single, ball])
    const [first, second] = documents(session)
    expect(first.about.atBatIndex).equals(0)
    expect(recordOf(first)).deep.include({
      actions: [ball, single],
      actionTimes: times.slice(0, 2)
    })
    expect(recordOf(second)).deep.include({
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
    expect(recordOf(reopened)?.actions).deep.equals([ball, strike, single])
    expect(recordOf(reopened)).not.have.property('actionTimes')
    const next = score(session, clock, [ball])
    expect(recordOf(documents(session)[1])?.actionTimes).deep.equals(next)
  })

  it('reads a record whose times do not match its actions as one without times (U3)', function () {
    const record = {
      version: 1,
      setupBefore: setupOf(game()),
      actions: [ball, strike]
    }
    const read = (actionTimes?: unknown): unknown =>
      recordOf({ teamStation: { ...record, actionTimes } })
    const plain = recordOf({ teamStation: record })
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
    expect(recordOf(timed)?.actionTimes).length(2)
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

  it('stamps a pitch recorded after an Undo now, unless it is the one undone (U41)', async function () {
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

    // The same pitch again keeps the time it was first taken at.
    session.undo()
    score(session, clock, [foul])
    expect(timesOf(session)).deep.equals([first, later])
    expect(undone).not.equals(later)
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
    score(session, clock, [foul])
    expect(timesOf(session)).deep.equals([times[0], times[2]])
    // ... until the foul after it shows it took the strike's place.
    score(session, clock, [foul])
    expect(timesOf(session)).deep.equals(times.slice(0, 3))
    // Undo again, part way: what it took joins what is still displaced.
    session.undo()
    score(session, clock, [foul, ball])
    expect(timesOf(session)).deep.equals(times)
    const [beyond] = score(session, clock, [ball])
    const [after] = score(session, clock, [strike])
    expect(timesOf(session)).deep.equals([...times, beyond, after])
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
    const shown = { keys: ['a', 'b'], times: [stamp(1), stamp(2)] }
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
        { keys: ['a', 'b'], times: [undefined, stamp(2)] },
        undefined
      )
    ).deep.equals({
      times: [stamp(500), stamp(2), stamp(502)],
      consumed: 2,
      past: true
    })
    expect(REPLACED_KEEPS_TIME_MS).equals(60_000)
  })

  it('matches a 300-action displaced tail in under 10 ms (U42)', function () {
    const scored = longGame()
    const keys = scored.map(keyOf)
    const times = keys.map((_, i) => new Date(START + i * 1000).toISOString())
    const applied = [...keys]
    applied[49] = keyOf(strike)
    const stamped = keys.map(() => new Date(START + 7200_000).toISOString())
    matchTimes(applied, stamped, { keys, times }, undefined)
    const started = performance.now()
    const matched = matchTimes(applied, stamped, { keys, times }, undefined)
    const took = performance.now() - started
    expect(matched.times).deep.equals(times)
    expect(took).lessThan(10)
  })
})
