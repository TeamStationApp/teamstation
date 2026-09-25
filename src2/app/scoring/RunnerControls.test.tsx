import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { RunnerControls } from './RunnerControls'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringEvent, ScoringState } from './scoringTypes'
let root: Root | undefined
let received: ScoringEvent[] = []
async function render(
  state: ScoringState,
  anchor: { x: number; y: number } | null = null
): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <RunnerControls
        state={state}
        anchor={anchor}
        dispatch={event => {
          received.push(event)
        }}
      />
    )
  })
}
async function click(label: string): Promise<void> {
  const node = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(node, label).not.equals(null)
  await act(async () => {
    node!.click()
  })
}
function initial(): ScoringState {
  return initialScoringState(createDevelopmentSession(gameFixture, [], []))
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  received = []
})
describe('runner decisions', function () {
  it('offers home Safe/Out and only a validated Back', async function () {
    let state = initial()
    state.session.liveData.linescore.offense.third = playerRef(state.session, 4)
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Single' })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 0, z: -30 },
      generation: 0
    })
    state = completeMotions(
      scoringReducer(state, { type: 'TRAJECTORY', angle: 20, generation: 0 })
    )
    await render(state)
    for (const label of ['Safe', 'Out']) {
      const button = document.querySelector(`[aria-label="${label}"]`)!
      expect(button.textContent).contains('At Home')
      const subtitle = button.lastElementChild!
      expect(getComputedStyle(subtitle).fontSize).equals('10.5px')
      expect(getComputedStyle(subtitle).textAlign).equals('center')
    }
    await click('Safe')
    await click('Out')
    await click('Back')
    expect(received).deep.equals([
      { type: 'HOME', decision: 'safe' },
      { type: 'HOME', decision: 'out' },
      { type: 'HOME', decision: 'back' }
    ])
    state.pendingPlay!.movements.find(move => move.playerId === 4)!.force = true
    await render(state)
    expect(document.querySelector('[aria-label="Back"]')).equals(null)
  })
  it('identifies each automatic destination below Safe and Out', async () => {
    for (const [base, subtitle] of [
      [1, 'At First'],
      [2, 'At Second'],
      [3, 'At Third']
    ] as const) {
      const state = initial()
      state.phase = 'runnerDecision'
      state.runnerAction = {
        playerId: 1,
        from: 0,
        to: base,
        origin: 'current',
        returnPhase: 'ready',
        purpose: 'droppedThirdStrike'
      }
      await render(state)
      for (const label of ['Safe', 'Out']) {
        const button = document.querySelector(`[aria-label="${label}"]`)!
        expect(button.textContent).equals(label + subtitle)
        expect(getComputedStyle(button.lastElementChild!).fontSize).equals(
          '10.5px'
        )
      }
      await click('Safe')
      expect(received.at(-1)).deep.equals({
        type: 'RUNNER_DECIDE',
        decision: 'safe'
      })
    }
  })
  it('presents stationary pickoff and advance reasons, and keeps an occupied destination disabled', async function () {
    let state = initial()
    state.session.liveData.linescore.offense.first = playerRef(state.session, 2)
    state = scoringReducer(state, { type: 'RUNNER_PROPOSE', id: 2, to: 1 })
    await render(state, { x: 200, y: 300 })
    await click('Safe from Pickoff')
    await click('Out')
    state = scoringReducer(state, { type: 'RUNNER_DECIDE', decision: 'out' })
    await render(state)
    for (const reason of [
      'Picked Off',
      'Offensive Interference',
      'Out on Appeal',
      'Other'
    ])
      await click(reason)
    await click('Cancel')
    expect(received.at(-1)).deep.equals({ type: 'RUNNER_CANCEL' })
    state.phase = 'runnerDecision'
    state.runnerAction!.to = 2
    state.runnerAction!.decision = undefined
    state.session.liveData.linescore.offense.second = playerRef(
      state.session,
      3
    )
    await render(state, { x: 100, y: 100 })
    expect(
      document
        .querySelector('[aria-label="Safe"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    state.session.liveData.linescore.offense.second = null
    state = scoringReducer(state, { type: 'RUNNER_DECIDE', decision: 'safe' })
    await render(state)
    for (const reason of [
      'Steal',
      'Throwing Error',
      'Fielding Error',
      'Defensive Indifference',
      'Other'
    ])
      await click(reason)
    expect(received.at(-1)).deep.equals({
      type: 'RUNNER_REASON',
      reason: 'Other'
    })
    await render(initial())
  })
  it('has only Out for a current-play hold and leaves defensive completion to the toast', async function () {
    let state = initial()
    state.session.liveData.linescore.offense.first = playerRef(state.session, 2)
    state = scoringReducer(state, { type: 'RUNNER_PROPOSE', id: 2, to: 1 })
    state.runnerAction!.origin = 'current'
    await render(state)
    expect(document.querySelector('[aria-label="Safe from Pickoff"]')).equals(
      null
    )
    await click('Out')
    state = scoringReducer(state, { type: 'RUNNER_DECIDE', decision: 'out' })
    state = scoringReducer(state, {
      type: 'THROWER',
      id: 10,
      point: { x: 0, z: -20 },
      generation: 0
    })
    await render(state)
    expect(document.querySelector('[aria-label="Done"]')).equals(null)
    await render(initial())
    expect(document.querySelector('[aria-label="Done"]')).equals(null)
  })
})
