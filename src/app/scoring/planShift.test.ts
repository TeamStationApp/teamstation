import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GamePlansResponse } from '../../common/api'
import type { PlanCell } from '../../common/gamePlan'
import {
  DEFAULT_PLAYING_TIME_RULES,
  type PlayingTimeRules
} from '../../common/playingTimeRules'
import type { ScoringAction } from '../../common/scoring/actions'
import type { Position, Side } from '../../common/scoring/state'
import { completeMotions } from '../../test/scoringHelpers'
import {
  PLAN_BLANK as BLANK,
  PLAN_START as START,
  PLAN_SWAPPED as SWAPPED,
  scoringPlans,
  scoringSidePlan as sidePlan
} from '../../test/scoringPlans'
import { scoringRoster } from '../../test/scoringSession'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import type { ScoringEvent, ScoringState } from './scoringTypes'

function initial(): ScoringState {
  return initialScoringState(
    createDevelopmentSession(gameFixture, scoringRoster(1), scoringRoster(10))
  )
}

const plans = (
  given: Parameters<typeof scoringPlans>[0]
): ScoringEvent & { type: 'PLANS' } => ({
  type: 'PLANS',
  plans: scoringPlans(given)
})

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

describe('plan shift', function () {
  it('logs the next inning’s defence as one roster save at the bottom’s third out', function () {
    let state = run(initial(), [plans({ home: sidePlan(10, { 2: SWAPPED }) })])
    state = strikeOutSide(state)
    expect(rosters(state.log)).deep.equals([])
    const before = state.log.length
    state = strikeOutSide(state)
    expect(state.session.liveData.linescore).includes({
      currentInning: 2,
      isTopInning: true
    })
    const shift = state.log
      .slice(before)
      .filter(action => action.type === 'lineup')
    expect(shift).has.length(1)
    expect(shift[0]).includes({ kind: 'roster', keepSlot: true })
    expect(state.log.at(-1)).equals(shift[0])
    expect(defenseOf(state, 'home')).deep.equals(fielded(10, SWAPPED))
    expect(defenseOf(state, 'away')).deep.equals(fielded(1))
    expect(state.planNotice).deep.equals({
      inning: 2,
      sides: ['home'],
      summary: '',
      refused: []
    })
  })

  it('does nothing at the top half’s end', function () {
    let state = run(initial(), [
      plans({ home: sidePlan(10, { 1: SWAPPED, 2: SWAPPED }) })
    ])
    state = strikeOutSide(state)
    expect(state.session.liveData.linescore.isTopInning).equals(false)
    expect(rosters(state.log)).deep.equals([])
    expect(state.planNotice).equals(undefined)
  })

  it('does nothing with no positions in the plan, with no plan, or with no next column, or a blank one', function () {
    const noPositions = Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map(inning => [inning, BLANK])
    )
    for (const given of [
      { home: sidePlan(10, noPositions) },
      { home: sidePlan(10, { 2: BLANK }) },
      { home: { ...sidePlan(10, {}), plan: null } },
      { home: sidePlan(10, { 2: SWAPPED }, { innings: 1 }) },
      {}
    ]) {
      let state = run(initial(), [plans(given)])
      state = run(state, [{ type: 'END_HALF' }, { type: 'END_HALF' }])
      expect(state.session.liveData.linescore.currentInning).equals(2)
      expect(rosters(state.log)).deep.equals([])
      expect(defenseOf(state, 'home')).deep.equals(fielded(10))
      expect(state.planNotice).equals(undefined)
    }
    // Nor before the plans are read.
    const unread = run(initial(), [{ type: 'END_HALF' }, { type: 'END_HALF' }])
    expect(rosters(unread.log)).deep.equals([])
  })

  it('reads a plan as on by its positions, not the flag it came with', function () {
    const swapped = sidePlan(10, { 2: SWAPPED })
    const flagged = (
      plan: typeof swapped,
      enabled: boolean
    ): typeof swapped => ({
      ...plan,
      plan: plan.plan == null ? null : { ...plan.plan, enabled }
    })
    let state = run(initial(), [plans({ home: flagged(swapped, false) })])
    state = run(state, [{ type: 'END_HALF' }, { type: 'END_HALF' }])
    expect(defenseOf(state, 'home')).deep.equals(fielded(10, SWAPPED))
    const blank = sidePlan(
      10,
      Object.fromEntries([1, 2, 3, 4, 5, 6].map(inning => [inning, BLANK]))
    )
    state = run(initial(), [plans({ home: flagged(blank, true) })])
    state = run(state, [{ type: 'END_HALF' }, { type: 'END_HALF' }])
    expect(rosters(state.log)).deep.equals([])
    expect(state.planNotice).equals(undefined)
  })

  it('does nothing once the game is over', function () {
    let state = run(initial(), [
      plans({ home: sidePlan(10, { 2: SWAPPED }) }),
      { type: 'END_HALF' },
      { type: 'END_GAME' }
    ])
    expect(state.session.final).equals(true)
    const log = state.log
    state = run(state, [{ type: 'END_HALF' }])
    expect(state.log).equals(log)
    expect(rosters(state.log)).deep.equals([])
  })

  it('does nothing in a replay, applied or watched', function () {
    const ends: ScoringAction[] = [
      { type: 'gameFlow', kind: 'endHalf' },
      { type: 'gameFlow', kind: 'endHalf' }
    ]
    const planned = plans({ home: sidePlan(10, { 2: SWAPPED }) })
    const replayed = run(initial(), [
      planned,
      { type: 'REPLAYED', actions: ends }
    ])
    expect(replayed.session.liveData.linescore.currentInning).equals(2)
    expect(rosters(replayed.log)).deep.equals([])
    const watching = run(
      initialScoringState(initial().session, false, { watching: true }),
      [planned, { type: 'REPLAYED', actions: ends }]
    )
    expect(watching.session.liveData.linescore.currentInning).equals(2)
    expect(rosters(watching.log)).deep.equals([])
  })

  it('takes the shift back with the third out’s Undo', function () {
    let state = run(initial(), [plans({ home: sidePlan(10, { 2: SWAPPED }) })])
    state = strikeOutSide(state)
    const top = state
    state = strikeOutSide(state)
    expect(rosters(state.log)).has.length(1)
    state = run(state, [{ type: 'UNDO' }])
    expect(state.session.liveData.linescore).includes({
      currentInning: 1,
      isTopInning: false,
      outs: 2
    })
    expect(rosters(state.log)).deep.equals([])
    expect(defenseOf(state, 'home')).deep.equals(fielded(10))
    expect(state.planNotice).equals(undefined)
    // The plans stay: they are the coach's, not the step's.
    expect(state.plans).equals(top.plans)
  })

  it('shifts on a manual End Half Inning too, and each side by its own plan', function () {
    const awayColumn: PlanCell[] = [
      'P',
      '1B',
      'C',
      '2B',
      'SS',
      '3B',
      'LF',
      'CF',
      'RF'
    ]
    let state = run(initial(), [
      plans({
        away: sidePlan(1, { 2: awayColumn }),
        home: sidePlan(10, { 2: SWAPPED })
      }),
      { type: 'END_HALF' },
      { type: 'END_HALF' }
    ])
    expect(rosters(state.log)).has.length(2)
    expect(defenseOf(state, 'away')).deep.equals(fielded(1, awayColumn))
    expect(defenseOf(state, 'home')).deep.equals(fielded(10, SWAPPED))
    expect(state.planNotice).deep.equals({
      inning: 2,
      sides: ['away', 'home'],
      summary: '',
      refused: []
    })
    // One Undo takes back the half's end and both shifts.
    state = run(state, [{ type: 'UNDO' }])
    expect(rosters(state.log)).deep.equals([])
    expect(defenseOf(state, 'away')).deep.equals(fielded(1))
  })

  it('skips a column that leaves nobody pitching and says why, leaving the out standing', function () {
    // Inning 2 benches the pitcher and gives nobody P.
    const benched: PlanCell[] = [
      '',
      'C',
      '1B',
      '2B',
      'SS',
      '3B',
      'LF',
      'CF',
      'RF'
    ]
    let state = run(initial(), [
      plans({
        away: sidePlan(1, { 2: SWAPPED }),
        home: sidePlan(10, { 2: benched })
      })
    ])
    state = strikeOutSide(state)
    state = strikeOutSide(state)
    expect(state.session.liveData.linescore).includes({
      currentInning: 2,
      isTopInning: true
    })
    expect(rosters(state.log)).has.length(1)
    expect(defenseOf(state, 'home')).deep.equals(fielded(10))
    expect(defenseOf(state, 'away')).deep.equals(fielded(1, SWAPPED))
    expect(state.planNotice).deep.equals({
      inning: 2,
      sides: ['away'],
      summary: '',
      refused: [{ side: 'home', reason: 'needs a pitcher' }]
    })
    // Refused on its own side, nothing is logged at all.
    const alone = run(initial(), [
      plans({ home: sidePlan(10, { 2: benched }) }),
      { type: 'END_HALF' },
      { type: 'END_HALF' }
    ])
    expect(rosters(alone.log)).deep.equals([])
    expect(alone.planNotice).deep.equals({
      inning: 2,
      sides: [],
      summary: '',
      refused: [{ side: 'home', reason: 'needs a pitcher' }]
    })
  })

  it('applies one side beside the other’s refusal with its own warnings, and keeps both refusals', function () {
    // Max Sits is one; the away Player 9 sits innings 1, 2 and 3.
    const rules: PlayingTimeRules = {
      ...DEFAULT_PLAYING_TIME_RULES,
      enforceSittingLimits: true,
      noConsecutiveSits: false,
      equalSittingOrder: 'off'
    }
    const sitting: PlanCell[] = [
      'P',
      'C',
      '1B',
      '2B',
      'SS',
      '3B',
      'LF',
      'CF',
      ''
    ]
    const benched: PlanCell[] = ['', ...sitting.slice(1, 8), 'RF']
    const state = run(initial(), [
      plans({
        away: sidePlan(1, { 1: sitting, 2: sitting, 3: sitting }, { rules }),
        home: sidePlan(10, { 2: benched })
      }),
      { type: 'END_HALF' },
      { type: 'END_HALF' }
    ])
    expect(defenseOf(state, 'away')).deep.equals(fielded(1, sitting))
    expect(defenseOf(state, 'home')).deep.equals(fielded(10))
    expect(state.planNotice).deep.equals({
      inning: 2,
      sides: ['away'],
      summary: '1 playing-time warning',
      refused: [{ side: 'home', reason: 'needs a pitcher' }]
    })
    // Both refused: each side's reason stays, the away side's first.
    const both = run(initial(), [
      plans({
        away: sidePlan(1, { 2: benched }),
        home: sidePlan(10, { 2: benched })
      }),
      { type: 'END_HALF' },
      { type: 'END_HALF' }
    ])
    expect(rosters(both.log)).deep.equals([])
    expect(both.planNotice).deep.equals({
      inning: 2,
      sides: [],
      summary: '',
      refused: [
        { side: 'away', reason: 'needs a pitcher' },
        { side: 'home', reason: 'needs a pitcher' }
      ]
    })
  })

  it('skips a column the game itself refuses, without throwing', function () {
    // A home batter the game no longer counts as the team's: every roster
    // save of that side is refused, the shift's too.
    const opened = initial()
    opened.session.gameData.players[18].teamId = 'elsewhere'
    const state = run(opened, [
      plans({ home: sidePlan(10, { 2: SWAPPED }) }),
      { type: 'END_HALF' },
      { type: 'END_HALF' }
    ])
    expect(state.session.liveData.linescore.currentInning).equals(2)
    expect(rosters(state.log)).deep.equals([])
    expect(state.planNotice?.refused).deep.equals([
      { side: 'home', reason: 'has an invalid or duplicate lineup player' }
    ])
  })

  it('shifts a column with a red warning, and counts it in the notice', function () {
    // Max Sits is one; Player 9 sits innings 1, 2 and 3.
    const rules: PlayingTimeRules = {
      ...DEFAULT_PLAYING_TIME_RULES,
      enforceSittingLimits: true,
      noConsecutiveSits: false,
      equalSittingOrder: 'off'
    }
    const sitting: PlanCell[] = [
      'P',
      'C',
      '1B',
      '2B',
      'SS',
      '3B',
      'LF',
      'CF',
      ''
    ]
    const state = run(initial(), [
      plans({
        home: sidePlan(10, { 1: sitting, 2: sitting, 3: sitting }, { rules })
      }),
      { type: 'END_HALF' },
      { type: 'END_HALF' }
    ])
    expect(defenseOf(state, 'home')).deep.equals(fielded(10, sitting))
    expect(state.planNotice?.summary).equals('1 playing-time warning')
  })

  it('keeps the notice until the next action, and through a plans read', function () {
    let state = run(initial(), [
      plans({ home: sidePlan(10, { 2: SWAPPED }) }),
      { type: 'END_HALF' },
      { type: 'END_HALF' }
    ])
    expect(state.planNotice?.inning).equals(2)
    state = run(state, [
      plans({ home: sidePlan(10, { 2: SWAPPED, 3: START }) })
    ])
    expect(state.planNotice?.inning).equals(2)
    state = run(state, [{ type: 'PITCH', kind: 'ball' }])
    expect(state.planNotice).equals(undefined)
    // The pitch's Undo brings it back, as the screen was before the pitch.
    state = run(state, [{ type: 'UNDO' }])
    expect(state.planNotice?.inning).equals(2)
  })

  it('keeps the plans through a reset', function () {
    const read: GamePlansResponse = {
      away: null,
      home: sidePlan(10, { 2: SWAPPED })
    }
    let state = run(initial(), [{ type: 'PLANS', plans: read }])
    state = run(state, [{ type: 'RESET', session: initial().session, log: [] }])
    expect(state.plans).equals(read)
    state = run(state, [{ type: 'END_HALF' }, { type: 'END_HALF' }])
    expect(defenseOf(state, 'home')).deep.equals(fielded(10, SWAPPED))
  })
})
