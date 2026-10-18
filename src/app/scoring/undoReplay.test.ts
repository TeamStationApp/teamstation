import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { outcomeEvents } from './scoringContract'
import {
  CHECKPOINT_SPACING,
  copyState,
  initialScoringState,
  keepsGame,
  scoringReducer
} from './scoringMachine'
import {
  CORRECTION_WINDOW_MS,
  type HistoryEntry,
  type ScoringDraft,
  type ScoringEvent,
  type ScoringSnapshot,
  type ScoringState
} from './scoringTypes'

/**
 * U34: Undo rebuilds the game by replaying the log from a checkpoint, and
 * gives exactly what a full copy of the state taken before the step gave.
 */

/** A small seeded generator, so a failing sequence can be run again. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function start(presentation = false): ScoringState {
  return initialScoringState(
    createDevelopmentSession(gameFixture, [], []),
    presentation
  )
}

const OUTCOMES = Object.keys(outcomeEvents) as Array<keyof typeof outcomeEvents>
const MORE = [
  'Wild Pitch',
  'Passed Ball',
  'Balk',
  'Hit by Pitch',
  'Intentional Walk',
  'Batter Out — Other'
] as const

/** Something a scorer might do next: often refused, which is fine. */
function nextEvent(state: ScoringState, roll: () => number): ScoringEvent {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(roll() * items.length)]
  const generation = state.generation
  const game = state.session.liveData.linescore
  const fielders = Object.values(game.defense)
    .filter(player => player != null)
    .map(player => player.id)
  const runners = [game.offense.first, game.offense.second, game.offense.third]
  const onBase = runners
    .map((runner, index) => (runner == null ? null : [runner.id, index + 1]))
    .filter(entry => entry != null)
  const point = (): { x: number; z: number } => ({
    x: Math.round(roll() * 160 - 80),
    z: -Math.round(20 + roll() * 180)
  })
  const choices: Array<[number, () => ScoringEvent]> = [
    [3, () => ({ type: 'UNDO' })],
    [
      5,
      () => ({ type: 'PITCH', kind: pick(['ball', 'called', 'swing', 'foul']) })
    ],
    [
      1.5,
      () => ({
        type: 'OUTCOME',
        outcome: pick(OUTCOMES),
        contactKind: roll() < 0.8 ? 'swing' : 'bunt'
      })
    ],
    [1, () => ({ type: 'MORE', input: { action: pick(MORE), base: 1 } })],
    [
      2,
      () => {
        const motion = state.motions.find(item => !item.complete)
        return motion == null
          ? { type: 'CLOSE_PLAY' }
          : {
              type: 'MOTION_DONE',
              id: motion.id,
              generation: motion.generation
            }
      }
    ],
    [1, () => ({ type: 'CLOSE_PLAY' })],
    [
      0.5,
      () => ({
        type: 'TIMER_TICK',
        elapsedMs: CORRECTION_WINDOW_MS,
        generation,
        revision: state.correctionWindow?.revision ?? 0
      })
    ],
    [
      2,
      () => {
        const [id, from] = onBase.length > 0 ? pick(onBase) : [0, 0]
        return {
          type: 'RUNNER_DROP',
          id,
          to: from + (roll() < 0.8 ? 1 : 0),
          decision: roll() < 0.6 ? 'safe' : 'out',
          generation
        }
      }
    ],
    [0.7, () => ({ type: 'RUNNER_CANCEL' })],
    [0.3, () => ({ type: 'CANCEL_RUNNER' })],
    [1, () => ({ type: 'HOME', decision: pick(['safe', 'out', 'back']) })],
    [1, () => ({ type: 'RUNNER_DECIDE', decision: pick(['safe', 'out']) })],
    [
      0.7,
      () => ({
        type: 'RUNNER_REASON',
        reason:
          state.moreDraft?.action ?? pick(['Steal', 'Caught Stealing', 'Error'])
      })
    ],
    [
      1,
      () => ({
        type: 'THROWER',
        id: pick(fielders),
        point: point(),
        generation
      })
    ],
    [
      1.5,
      () =>
        roll() < 0.5
          ? { type: 'DEFENDER', id: pick(fielders), point: point(), generation }
          : { type: 'DEFENDER', generation, runnerPoint: point() }
    ],
    [
      0.5,
      () => {
        const route = state.runnerAction?.defensiveRoute ?? []
        return route.length > 0 && roll() < 0.7
          ? { type: 'ERROR_CREDIT', id: pick(route).id, generation }
          : { type: 'ERROR_CANCEL' }
      }
    ],
    [
      2,
      () => ({
        type: 'FIELDER',
        id: pick(fielders),
        point: point(),
        generation
      })
    ],
    [1, () => ({ type: 'LANDING', point: point(), generation })],
    [
      2,
      () => ({
        type: 'TRAJECTORY',
        angle: Math.round(roll() * 70 - 10),
        generation,
        dragged: roll() < 0.5
      })
    ],
    [0.2, () => ({ type: 'END_HALF' })],
    [0.3, () => ({ type: 'SWITCH_SIDE', side: pick(['L', 'R']) })],
    [0.3, () => ({ type: 'GESTURE', active: roll() < 0.3 })]
  ]
  const presentation = state.presentation
  if (presentation != null)
    choices.push([
      8,
      () =>
        presentation.kind === 'hit' && presentation.stage === 'swing'
          ? {
              type: 'PRESENTATION_CONTACT',
              id: presentation.id,
              generation: presentation.generation
            }
          : {
              type: 'PRESENTATION_DONE',
              id: presentation.id,
              generation: presentation.generation,
              stage: presentation.stage
            }
    ])
  const celebration = state.celebration
  if (celebration != null)
    choices.push([
      2,
      () => ({
        type: 'CELEBRATION_DONE',
        id: celebration.id,
        generation: celebration.generation
      })
    ])
  const total = choices.reduce((sum, [weight]) => sum + weight, 0)
  let at = roll() * total
  for (const [weight, make] of choices) {
    at -= weight
    if (at < 0) return make()
  }
  return choices[0][1]()
}

/** The state without its history, as plain data to compare. */
function plain(state: object): unknown {
  const {
    past: _past,
    checkpoints: _checkpoints,
    ...rest
  } = state as ScoringState
  return copyState(rest)
}

/**
 * The full-copy history the screen used to keep: the whole state, game and
 * all, before every step and at the start of every draft. It learns the game
 * at each log length from the states the screen passes through going
 * forwards, never from an Undo.
 */
class FullCopyReference {
  /** The game at each log length on the current line of play. */
  private readonly games = new Map<number, string>()
  private readonly copies = new WeakMap<
    HistoryEntry | ScoringDraft,
    ScoringSnapshot
  >()

  /** A full copy of the state that `where` was recorded from. */
  private fullCopy(
    state: ScoringState,
    where: HistoryEntry | ScoringDraft
  ): ScoringSnapshot {
    const held = this.copies.get(where)
    if (held != null) return held
    const game = this.games.get(where.logLength)
    if (game == null)
      throw new Error(`No game seen at log length ${where.logLength}`)
    const copy: ScoringSnapshot = {
      ...copyState(where.screen),
      session: JSON.parse(game) as ScoringSnapshot['session'],
      log: copyState(state.log.slice(0, where.logLength))
    }
    this.copies.set(where, copy)
    return copy
  }

  /** Remembers what `state` shows, and a full copy of each new step. */
  saw(state: ScoringState): void {
    for (const length of [...this.games.keys()])
      if (length > state.log.length) this.games.delete(length)
    this.games.set(state.log.length, JSON.stringify(state.session))
    for (const entry of state.past) this.fullCopy(state, entry)
    const draft = state.runnerDraft ?? state.moreDraft
    if (draft != null) this.fullCopy(state, draft)
  }

  /** The game seen at a log length, as JSON. */
  gameText(logLength: number): string | undefined {
    return this.games.get(logLength)
  }

  /** The game seen at a log length, as plain data. */
  gameAt(logLength: number): unknown {
    const game = this.games.get(logLength)
    return game == null ? undefined : JSON.parse(game)
  }

  /** What an Undo of the last step gave with full copies. */
  undo(state: ScoringState): unknown {
    const entry = state.past.at(-1)!
    const next: ScoringSnapshot = {
      ...copyState(this.fullCopy(state, entry)),
      presentation: null,
      celebration: null,
      generation: state.generation + 1
    }
    for (const motion of next.motions) motion.generation = next.generation
    if (next.correctionWindow != null)
      next.correctionWindow = {
        remainingMs: CORRECTION_WINDOW_MS,
        revision: next.correctionWindow.revision + 1
      }
    return plain(next)
  }

  /** What cancelling the draft gave with full copies. */
  cancel(state: ScoringState): unknown {
    const draft = (state.runnerDraft ?? state.moreDraft)!
    const next: ScoringSnapshot = {
      ...copyState(this.fullCopy(state, draft)),
      celebration: null,
      generation: state.generation + 1
    }
    for (const motion of next.motions) motion.generation = next.generation
    if (next.correctionWindow != null) next.correctionWindow.revision++
    return plain(next)
  }
}

/** Checkpoints already checked, which do not change once made. */
const checked = new WeakSet<object>()

/** Checks one state's checkpoints against the games seen going forwards. */
function checkCheckpoints(
  state: ScoringState,
  reference: FullCopyReference
): void {
  state.checkpoints.forEach((point, index) => {
    expect(point.logLength).lessThanOrEqual(state.log.length)
    if (index > 0)
      expect(point.logLength).greaterThanOrEqual(
        state.checkpoints[index - 1].logLength
      )
    // The first, every tenth and the newest two hold a game; no other does.
    expect(point.session != null, `checkpoint ${index}`).equals(
      keepsGame(index, state.checkpoints.length)
    )
    if (point.session != null && !checked.has(point)) {
      checked.add(point)
      expect(JSON.stringify(point.session)).equals(
        reference.gameText(point.logLength)
      )
    }
  })
}

/** Runs one seeded sequence, checking every Undo and cancel as it goes. */
function runSequence(seed: number, steps: number): { undos: number } {
  const roll = random(seed)
  let state = start(seed % 3 === 0)
  const reference = new FullCopyReference()
  reference.saw(state)
  let undos = 0
  // A few appearances pitched first, so later runs of Undo cross them.
  const opening = 2 + Math.floor(roll() * 8)
  for (let tries = 0; tries < 200; tries++) {
    if (state.session.liveData.plays.allPlays.length >= opening) break
    const kind = (['ball', 'called', 'swing', 'foul'] as const)[
      Math.floor(roll() * 4)
    ]
    state = scoringReducer(state, { type: 'PITCH', kind })
    state = completeMotions(state)
    if (state.presentation != null)
      state = scoringReducer(state, {
        type: 'PRESENTATION_DONE',
        id: state.presentation.id,
        generation: state.presentation.generation,
        stage: state.presentation.stage
      })
    state = scoringReducer(state, { type: 'CLOSE_PLAY' })
    reference.saw(state)
  }
  // Now and then the scorer undoes a run of steps, back over appearances.
  let streak = 0
  for (let step = 0; step < steps; step++) {
    const event: ScoringEvent =
      streak > 0 ? { type: 'UNDO' } : nextEvent(state, roll)
    if (streak > 0) streak--
    else if (event.type === 'UNDO' && roll() < 0.12)
      streak = 5 + Math.floor(roll() * 35)
    const before = state
    // What full copies give, worked out before the step is taken.
    const draft = before.runnerDraft ?? before.moreDraft
    const next = scoringReducer(before, event)
    const where = `seed ${seed}, step ${step}, ${event.type}`
    if (next !== before && next.generation === before.generation + 1) {
      if (
        draft != null &&
        next.runnerDraft == null &&
        next.moreDraft == null &&
        next.past.length === draft.historyLength &&
        next.log.length === draft.logLength
      ) {
        expect(plain(next), where).deep.equals(reference.cancel(before))
        undos++
      } else if (
        event.type === 'UNDO' &&
        next.past.length === before.past.length - 1
      ) {
        expect(plain(next), where).deep.equals(reference.undo(before))
        expect(next.past).deep.equals(before.past.slice(0, -1))
        undos++
      }
    }
    if (next.log.length < before.log.length)
      expect(copyState(next.session), where).deep.equals(
        reference.gameAt(next.log.length)
      )
    state = next
    reference.saw(state)
    checkCheckpoints(state, reference)
  }
  return { undos }
}

describe('undo by replaying the log (U34)', function () {
  it('gives what full copies gave, over 200 seeded random sequences', function () {
    this.timeout(120_000)
    let undos = 0
    for (let seed = 1; seed <= 200; seed++)
      undos += runSequence(seed, 150).undos
    // The sequences really do undo, and often.
    expect(undos).greaterThan(2000)
  })

  describe('across boundaries', function () {
    const pitches = (
      state: ScoringState,
      kind: 'ball' | 'called' | 'swing' | 'foul',
      times: number
    ): ScoringState => {
      for (let i = 0; i < times; i++)
        state = completeMotions(scoringReducer(state, { type: 'PITCH', kind }))
      return scoringReducer(state, { type: 'CLOSE_PLAY' })
    }
    const undo = (state: ScoringState): ScoringState =>
      scoringReducer(state, { type: 'UNDO' })
    const game = (state: ScoringState): unknown => copyState(state.session)

    it('undoes into the plate appearance before, rebuilt from its checkpoint', function () {
      let state = start()
      const walked: ScoringState[] = []
      for (let i = 0; i < 4; i++) {
        walked.push(state)
        state = pitches(state, 'ball', 1)
      }
      expect(state.session.liveData.plays.allPlays).has.length(1)
      state = pitches(state, 'called', 1)
      expect(state.checkpoints.map(point => point.logLength)).deep.equals([
        0,
        walked[3].log.length + 2
      ])
      state = undo(undo(state))
      expect(state.session.liveData.plays.allPlays).has.length(0)
      expect(game(state)).deep.equals(game(walked[3]))
      expect(state.log).deep.equals(walked[3].log)
      expect(state.checkpoints).has.length(1)
    })

    it('undoes across a half, and back to before the first pitch', function () {
      let state = start()
      const seen: ScoringState[] = [state]
      // Three strikeouts end the top of the first, then four walks.
      for (let batter = 0; batter < 3; batter++)
        for (let i = 0; i < 3; i++)
          seen.push((state = pitches(state, 'swing', 1)))
      expect(state.session.liveData.linescore.isTopInning).equals(false)
      for (let batter = 0; batter < 4; batter++)
        for (let i = 0; i < 4; i++)
          seen.push((state = pitches(state, 'ball', 1)))
      expect(state.past).has.length(seen.length - 1)
      // Seven appearances: the first checkpoint and the newest two hold games.
      expect(state.checkpoints).has.length(7)
      expect(state.checkpoints.map(point => point.session != null)).deep.equals(
        [true, false, false, false, false, true, true]
      )
      for (let back = seen.length - 2; back >= 0; back--) {
        state = undo(state)
        expect(game(state), `undo to ${back}`).deep.equals(game(seen[back]))
        expect(state.log).deep.equals(seen[back].log)
        expect(state.phase).equals(seen[back].phase)
        expect(
          state.checkpoints.filter(point => point.session != null).length
        ).lessThanOrEqual(3)
      }
      expect(state.past).deep.equals([])
      expect(state.log).deep.equals([])
      expect(game(state)).deep.equals(game(start()))
      expect(undo(state)).equals(state)
      // Scoring on from there takes checkpoints again.
      state = pitches(state, 'ball', 1)
      expect(state.checkpoints.map(point => point.logLength)).deep.equals([0])
    })

    it('replays at most about ten appearances, however far back an Undo reaches', function () {
      // Forty appearances of five pitches, strikeouts and walks in turn.
      let state = start()
      const seen: ScoringState[] = [state]
      for (let appearance = 0; appearance < 40; appearance++)
        for (const kind of appearance % 2 === 0
          ? (['foul', 'called', 'ball', 'ball', 'swing'] as const)
          : (['ball', 'foul', 'ball', 'ball', 'ball'] as const)) {
          state = completeMotions(
            scoringReducer(state, { type: 'PITCH', kind })
          )
          if (state.phase === 'correctionWindow')
            state = scoringReducer(state, { type: 'CLOSE_PLAY' })
          seen.push(state)
        }
      expect(state.session.liveData.plays.allPlays).has.length(40)
      // Copies of the game at 0, 10, 20, 30 and the newest two.
      expect(
        state.checkpoints.flatMap((point, index) =>
          point.session != null ? [index] : []
        )
      ).deep.equals([0, 10, 20, 30, 38, 39])
      // The log's length as each appearance opened.
      const opened = state.checkpoints.map(point => point.logLength)
      // Which log entries an Undo reads: each is watched as it is applied.
      const read = new Set<number>()
      const watched = (from: ScoringState): ScoringState => ({
        ...from,
        log: from.log.map(
          (action, index) =>
            new Proxy(action, {
              get(target, key, receiver) {
                read.add(index)
                return Reflect.get(target, key, receiver) as unknown
              }
            })
        )
      })
      const readSpan = (): number =>
        read.size === 0 ? 0 : Math.max(...read) - Math.min(...read) + 1

      // One Undo straight back twelve appearances, to the last pitch of the
      // 28th: rebuilt from the copy at the 20th, never from the first.
      const target = seen.findLastIndex(
        earlier => earlier.session.liveData.plays.allPlays.length === 28
      )
      const far = watched({
        ...state,
        past: state.past.slice(0, target + 1)
      })
      read.clear()
      const back = undo(far)
      expect(game(back)).deep.equals(game(seen[target]))
      expect(Math.min(...read)).equals(opened[20])
      expect(read.size).equals(readSpan())
      expect(read.size).lessThanOrEqual(opened[30] - opened[20])

      // Undoing one step at a time from the fortieth back to the 27th, no
      // Undo reads more than ten appearances of the log.
      let most = 0
      state = watched(state)
      for (let step = seen.length - 2; step >= target - 5 * 2; step--) {
        read.clear()
        state = undo(state)
        expect(game(state), `undo to ${step}`).deep.equals(game(seen[step]))
        most = Math.max(most, read.size)
        const appearance = state.session.liveData.plays.allPlays.length
        if (read.size > 0)
          expect(Math.min(...read)).greaterThanOrEqual(
            opened[Math.max(0, appearance - CHECKPOINT_SPACING)]
          )
      }
      // Crossing into the 29th rebuilds the 28th and 29th from the 20th.
      expect(most).greaterThan(opened[29] - opened[20] - 1)
      expect(most).lessThanOrEqual(opened[30] - opened[20])
    })

    it('cancels a More draft back to where it began, across a closed play', function () {
      let state = start()
      for (let i = 0; i < 4; i++) state = pitches(state, 'ball', 1)
      const before = state
      state = scoringReducer(state, {
        type: 'MORE',
        input: { action: 'Wild Pitch' }
      })
      expect(state.moreDraft).deep.include({
        historyLength: before.past.length,
        logLength: before.log.length
      })
      state = scoringReducer(state, {
        type: 'RUNNER_DROP',
        id: before.session.liveData.linescore.offense.first!.id,
        to: 2,
        decision: 'safe',
        generation: state.generation
      })
      state = scoringReducer(state, { type: 'RUNNER_PITCH', addBall: false })
      expect(state.log.length).greaterThan(before.log.length)
      expect(state.past).has.length(before.past.length + 1)
      state = undo(state)
      expect(game(state)).deep.equals(game(before))
      expect(state.log).deep.equals(before.log)
      expect(state.phase).equals(before.phase)
    })

    it('refuses to undo without a checkpoint to rebuild from', function () {
      const state = pitches(start(), 'ball', 1)
      expect(() => undo({ ...state, checkpoints: [] })).throws(/No checkpoint/)
    })

    it('says so if the log no longer replays', function () {
      const state = pitches(start(), 'ball', 3)
      // A pitch the library cannot read, where a ball was.
      const unreadable = JSON.parse(
        '{"type":"pitch","call":"Q"}'
      ) as ScoringState['log'][number]
      const broken: ScoringState = {
        ...state,
        log: [state.log[0], unreadable, ...state.log.slice(2)]
      }
      expect(() => undo(broken)).throws(/does not replay at 1/)
    })
  })
})
