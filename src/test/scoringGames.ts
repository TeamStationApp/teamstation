import { expect } from 'chai'

import type { ScoringAction } from '../common/scoring/actions'
import { type Applied, applyAction } from '../common/scoring/apply'
import { baseIds, freshGame, newSetup } from '../common/scoring/lineup'
import { nextDecision } from '../common/scoring/rules'
import type { GameState } from '../common/scoring/state'

/**
 * Games for the scoring library's tests. Nine made-up players a side: the
 * visitors are 1-9 and bat in that order; the home side is 10-18, fielding
 * P 10, C 11, 1B 12, 2B 13, SS 14, 3B 15, LF 16, CF 17, RF 18.
 */
export const TEAMS = {
  away: { id: 'team-away', name: 'Visitors' },
  home: { id: 'team-home', name: 'Hosts' }
}
export const F = {
  P: 10,
  C: 11,
  '1B': 12,
  '2B': 13,
  SS: 14,
  '3B': 15,
  LF: 16,
  CF: 17,
  RF: 18
} as const

export function game(): GameState {
  const roster = (
    start: number
  ): Array<{ userId: number; shortName: string; jersey: string }> =>
    Array.from({ length: 9 }, (_, i) => ({
      userId: start + i,
      shortName: `Player ${i + 1}`,
      jersey: String(i + 1)
    }))
  return freshGame(
    'g1',
    TEAMS,
    newSetup(TEAMS, { away: roster(1), home: roster(10) })
  )
}

/**
 * Applies each action, failing the test on the first one refused. The
 * transitions are every action's, in order.
 */
export function play(state: GameState, ...actions: ScoringAction[]): Applied {
  let applied: Applied = {
    state,
    transitions: [],
    play: null,
    problems: []
  }
  for (const action of actions) {
    const next = applyAction(applied.state, action)
    expect(next.problems, JSON.stringify(action)).deep.equals([])
    applied = {
      ...next,
      transitions: [...applied.transitions, ...next.transitions]
    }
  }
  return applied
}

/** The same, returning only the game. */
export function after(
  state: GameState,
  ...actions: ScoringAction[]
): GameState {
  return play(state, ...actions).state
}

export const ball: ScoringAction = { type: 'pitch', call: 'B' }
export const strike: ScoringAction = { type: 'pitch', call: 'C' }
export const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }

/** Closes a decided play, as the scorer's next action would. */
export function closed(state: GameState): GameState {
  return nextDecision(state) === 'close' ? after(state, close) : state
}
export function walk(state: GameState): GameState {
  return closed(after(state, ball, ball, ball, ball))
}
export function strikeout(state: GameState): GameState {
  return closed(after(state, strike, strike, strike))
}
export function single(state: GameState): GameState {
  return after(
    state,
    { type: 'ballInPlay', contact: 'swing', fielder: F.CF },
    { type: 'result', eventType: 'single' }
  )
}

export function bases(state: GameState): Array<number | null> {
  return baseIds(state)
}
export function outs(state: GameState): number {
  return state.liveData.linescore.outs
}
export function runs(state: GameState, side: 'away' | 'home' = 'away'): number {
  return state.liveData.linescore.teams[side].runs
}
