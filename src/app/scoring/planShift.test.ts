import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { PlanCell, PlanColumnCell } from '../../common/gamePlan'
import type { ScoringAction } from '../../common/scoring/actions'
import { copyGame, type Position, type Side } from '../../common/scoring/state'
import { completeMotions } from '../../test/scoringHelpers'
import {
  PLAN_BLANK as BLANK,
  PLAN_START as START,
  PLAN_SWAPPED as SWAPPED
} from '../../test/scoringPlans'
import { scoringRoster } from '../../test/scoringSession'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { overrideDraftOf } from './overrideModel'
import {
  initialScoringState,
  planInningWaits,
  scoringReducer,
  scoringScreenModel,
  scoringScreenReducer
} from './scoringMachine'
import type { ScoringEvent, ScoringState } from './scoringTypes'

function initial(): ScoringState {
  return initialScoringState(
    createDevelopmentSession(gameFixture, scoringRoster(1), scoringRoster(10))
  )
}

function run(
  state: ScoringState,
  events: readonly ScoringEvent[]
): ScoringState {
  for (const event of events)
    state = completeMotions(scoringReducer(state, event))
  return state
}

/** Three strikeouts: the half ends on the third. */
function strikeOutSide(state: ScoringState): ScoringState {
  for (let out = 0; out < 3; out++) {
    state = run(state, [
      { type: 'PITCH', kind: 'swing' },
      { type: 'PITCH', kind: 'swing' },
      { type: 'PITCH', kind: 'swing' }
    ])
    if (state.phase === 'correctionWindow')
      state = run(state, [{ type: 'CLOSE_PLAY' }])
  }
  return state
}

/** Into the top of the 2nd: both halves of the 1st struck out. */
const intoSecond = (): ScoringState => strikeOutSide(strikeOutSide(initial()))

/**
 * The column of the side whose first player is `first` (1 away, 10 home),
 * as the inning route answers it: a cell per batter, in batting order here.
 */
const column = (first: number, cells: readonly PlanCell[]): PlanColumnCell[] =>
  cells.map((cell, at) => ({
    player: {
      gumboId: first + at,
      fullName: `Player ${at + 1}`,
      jersey: String(at + 1)
    },
    cell
  }))

const planInning = (
  side: Side,
  inning: number,
  cells: readonly PlanCell[]
): ScoringEvent => ({
  type: 'PLAN_INNING',
  side,
  inning,
  column: column(side === 'away' ? 1 : 10, cells)
})

const rosters = (log: readonly ScoringAction[]): ScoringAction[] =>
  log.filter(action => action.type === 'lineup' && action.kind === 'roster')

const defenseOf = (
  state: ScoringState,
  side: Side
): Record<Position, number | null> =>
  state.session.liveData.boxscore.teams[side].defense

/** The starting defence of a side, or with the positions given changed. */
function fielded(
  first: number,
  cells: readonly PlanCell[] = START
): Record<string, number | null> {
  const defense: Record<string, number | null> = Object.fromEntries(
    START.map(position => [position, null])
  )
  cells.forEach((cell, at) => {
    if (cell in defense) defense[cell] = first + at
  })
  return defense
}

describe('plan innings in the scoring reducer', function () {
  describe('the inning entered', function () {
    it('is set when the bottom’s third out starts the next inning, and not at the top’s', function () {
      let state = strikeOutSide(initial())
      expect(state.session.liveData.linescore.currentInning).equals(1)
      expect(state.inningStart).equals(undefined)
      state = strikeOutSide(state)
      expect(state.session.liveData.linescore.currentInning).equals(2)
      expect(state.inningStart).deep.equals({ inning: 2, id: 1 })
      // Nothing is logged for the plan until its column lands.
      expect(rosters(state.log)).deep.equals([])
    })

    it('is set by an Undo back across an inning’s end, and only grows when the same end comes again', function () {
      let state = intoSecond()
      // The third out's play, taken back, leaves the 1st again.
      while (state.session.liveData.linescore.currentInning === 2)
        state = run(state, [{ type: 'UNDO' }])
      expect(state.inningStart).deep.equals({ inning: 1, id: 2 })
      state = strikeOutSide(state)
      expect(state.session.liveData.linescore.currentInning).equals(2)
      expect(state.inningStart?.inning).equals(2)
      expect(state.inningStart?.id).greaterThan(2)
    })

    it('is set by the Override editor’s inning and by End Half Inning', function () {
      let state = initial()
      const draft = { ...overrideDraftOf(state.session), inning: 3 }
      state = run(state, [{ type: 'OVERRIDE', draft }])
      expect(state.session.liveData.linescore.currentInning).equals(3)
      expect(state.inningStart).deep.equals({ inning: 3, id: 1 })
      state = run(state, [{ type: 'END_HALF' }, { type: 'END_HALF' }])
      expect(state.inningStart).deep.equals({ inning: 4, id: 2 })
    })

    it('is set when a saved Undo takes the game back across an inning', function () {
      const first = strikeOutSide(initial())
      const saved = { session: copyGame(first.session), log: first.log }
      const model = scoringScreenModel(strikeOutSide(first))
      expect(model.scoring.inningStart).deep.equals({ inning: 2, id: 1 })
      const back = scoringScreenReducer(model, {
        type: 'SAVED_UNDONE',
        undone: saved
      })
      expect(back.scoring.session.liveData.linescore.currentInning).equals(1)
      expect(back.scoring.inningStart).deep.equals({ inning: 1, id: 2 })
      // One that could not be taken back changes nothing.
      expect(
        scoringScreenReducer(model, { type: 'SAVED_UNDONE' }).scoring
          .inningStart
      ).deep.equals({ inning: 2, id: 1 })
    })

    it('is not set by another device’s game, a replay, an applied column, a watching screen or a finished game', function () {
      const later = intoSecond()
      // Another device's game, read in.
      const reset = run(initial(), [
        { type: 'RESET', session: copyGame(later.session), log: later.log }
      ])
      expect(reset.session.liveData.linescore.currentInning).equals(2)
      expect(reset.inningStart).equals(undefined)
      // A replay's steps across the inning.
      const replayed = run(initial(), [
        { type: 'REPLAYED', actions: later.log }
      ])
      expect(replayed.session.liveData.linescore.currentInning).equals(2)
      expect(replayed.inningStart).equals(undefined)
      // A screen watching another's scoring.
      const watching = strikeOutSide(
        strikeOutSide({ ...initial(), watching: true })
      )
      expect(watching.inningStart).equals(undefined)
      // The column itself never moves the inning.
      const applied = run(later, [planInning('home', 2, SWAPPED)])
      expect(applied.inningStart).deep.equals(later.inningStart)
      // A game ended moves no inning on.
      const ended = run(intoSecond(), [{ type: 'END_GAME' }])
      expect(ended.session.final).equals(true)
      expect(run(ended, [{ type: 'END_HALF' }]).inningStart).deep.equals(
        ended.inningStart
      )
    })
  })

  describe('a column downloaded', function () {
    it('puts its side in that inning’s defence as one roster save, keeping the batting slots, taken back by one Undo', function () {
      const before = intoSecond()
      const order = [
        ...before.session.liveData.boxscore.teams.home.battingOrder
      ]
      const state = run(before, [planInning('home', 2, SWAPPED)])
      expect(defenseOf(state, 'home')).deep.equals(fielded(10, SWAPPED))
      expect(defenseOf(state, 'away')).deep.equals(defenseOf(before, 'away'))
      expect(
        state.session.liveData.boxscore.teams.home.battingOrder
      ).deep.equals(order)
      const logged = rosters(state.log.slice(before.log.length))
      expect(logged).has.length(1)
      expect(logged[0]).includes({ kind: 'roster', keepSlot: true })
      expect(state.past).has.length(before.past.length + 1)
      expect(defenseOf(run(state, [{ type: 'UNDO' }]), 'home')).deep.equals(
        defenseOf(before, 'home')
      )
    })

    it('replaces a defence the scorer changed by hand: the coach takes priority', function () {
      const before = run(intoSecond(), [planInning('home', 2, SWAPPED)])
      const coach: PlanCell[] = [
        'P',
        'C',
        '1B',
        'SS',
        '2B',
        '3B',
        'LF',
        'CF',
        'RF'
      ]
      const state = run(before, [planInning('home', 2, coach)])
      expect(defenseOf(state, 'home')).deep.equals(fielded(10, coach))
    })

    it('logs nothing for a column the side already fields, which inningDefense answers null, as when another screen’s save of it was read in first', function () {
      const once = run(intoSecond(), [planInning('home', 2, SWAPPED)])
      expect(scoringReducer(once, planInning('home', 2, SWAPPED))).equals(once)
    })

    it('lets the scorer field a ball after the column applied', function () {
      const state = run(intoSecond(), [planInning('home', 2, SWAPPED)])
      const chosen = scoringReducer(state, {
        type: 'OUTCOME',
        outcome: 'Ball Caught'
      })
      const centre = defenseOf(chosen, 'home').CF!
      const located = scoringReducer(chosen, {
        type: 'FIELDER',
        id: centre,
        point: { x: 0, z: -200 },
        generation: chosen.generation
      })
      expect(located.phase).equals('trajectory')
    })

    it('takes a benched player off the field', function () {
      const benched: PlanCell[] = [...START.slice(0, 8), '']
      const state = run(intoSecond(), [planInning('home', 2, benched)])
      expect(defenseOf(state, 'home')).deep.equals({
        ...fielded(10),
        RF: null
      })
    })

    it('changes nothing for another inning, an empty column, a column with nobody pitching, mid-play, on a watching screen or once the game is over', function () {
      const state = intoSecond()
      const noPitcher: PlanCell[] = ['', ...SWAPPED.slice(1)]
      for (const [label, event] of [
        ['inning 3', planInning('home', 3, SWAPPED)],
        ['inning 1', planInning('home', 1, SWAPPED)],
        ['empty', { type: 'PLAN_INNING', side: 'home', inning: 2, column: [] }],
        ['all benched', planInning('home', 2, BLANK)],
        ['no pitcher', planInning('home', 2, noPitcher)]
      ] as const)
        expect(scoringReducer(state, event), label).equals(state)
      const draft: Partial<ScoringState> = { moreDraft: state.moreDraft }
      draft.moreDraft ??= { action: 'pickoff' } as unknown as NonNullable<
        ScoringState['moreDraft']
      >
      const busyStates: Array<Partial<ScoringState>> = [
        { phase: 'locateFielder' },
        draft,
        { dictationQuestion: { transcript: 'two balls', question: 'Which?' } },
        { reel: [] },
        { queuedDictation: [{ transcript: 'ball', actions: [] }] },
        { celebration: { id: 1 } as unknown as ScoringState['celebration'] }
      ]
      for (const busy of busyStates) {
        const waiting: ScoringState = { ...state, ...busy }
        const label = Object.keys(busy).join()
        expect(planInningWaits(waiting), label).equals(true)
        const after = scoringReducer(waiting, planInning('home', 2, SWAPPED))
        expect(rosters(after.log), label).deep.equals(rosters(state.log))
      }
      expect(planInningWaits(state)).equals(false)
      const watching: ScoringState = { ...state, watching: true }
      expect(scoringReducer(watching, planInning('home', 2, SWAPPED))).equals(
        watching
      )
      const ended = run(state, [{ type: 'END_GAME' }])
      expect(scoringReducer(ended, planInning('home', 2, SWAPPED))).equals(
        ended
      )
    })
  })
})
