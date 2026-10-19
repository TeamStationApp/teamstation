import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PerspectiveCamera } from 'three'

import { applyAction } from '../../common/scoring/session'
import { asGameState } from '../../common/scoring/state'
import { completeMotions } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { projectBases } from '../field/baseProjection'
import { applyFieldCamera } from '../field/cameraModel'
import type { BaseProjection } from '../field/fieldTypes'
import { gameFixture } from './isUnscoredGame.test'
import { homeDecisionFrame } from './runnerControlLayout'
import { RunnerControls } from './RunnerControls'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringEvent, ScoringState } from './scoringTypes'
let root: Root | undefined
let received: ScoringEvent[] = []
async function render(
  state: ScoringState,
  anchor: { x: number; y: number } | null = null,
  projection?: BaseProjection
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
        projection={projection}
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
  return initialScoringState(scoringSession(gameFixture))
}
describe('runner decisions', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    received = []
  })
  it('separates all three home calls after reopening a preserved batter advance', async function () {
    let state = initial()
    for (const [index, base] of (
      ['first', 'second', 'third'] as const
    ).entries())
      state.session.liveData.linescore.offense[base] = playerRef(
        state.session,
        index + 6
      )
    for (const event of [
      { type: 'OUTCOME', outcome: "Fielder's Choice" },
      { type: 'FIELDER', id: 15, point: { x: 0, z: -25 }, generation: 0 },
      { type: 'TRAJECTORY', angle: 20, generation: 0 }
    ] as ScoringEvent[])
      state = completeMotions(scoringReducer(state, event))
    const applied = applyAction(state.session, {
      type: 'runnerMovement',
      runner: 1,
      to: '3B'
    })
    expect(applied.problems).deep.equals([])
    state = initialScoringState(
      asGameState(JSON.parse(JSON.stringify(applied.state)))
    )
    for (const event of [
      { type: 'THROWER', id: 15, point: { x: 0, z: -25 }, generation: 0 },
      { type: 'DEFENDER', generation: 0 }
    ] as ScoringEvent[])
      state = completeMotions(scoringReducer(state, event))
    expect(state.phase).equals('fieldersChoice')
    expect(
      state.pendingPlay!.fieldersChoice!.runners.map(move => move.to)
    ).deep.equals([4, 4, 4])
    for (const [width, height] of [
      [874, 292],
      [568, 320],
      [402, 579]
    ]) {
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        width,
        height,
        view: 'home',
        zoom: 1,
        tilt: 0,
        heightOffset: 33,
        bottomExtension: 112
      })
      await render(state, null, projectBases(camera, width, height))
      const groups = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[aria-label^="Fielder\'s choice decision for"]'
        )
      )
      expect(groups).length(3)
      expect(groups.every(group => group.style.flexDirection === 'row')).equals(
        true
      )
      const tops = groups
        .map(group => parseFloat(group.style.top))
        .sort((a, b) => a - b)
      expect(tops[1] - tops[0]).at.least(52)
      expect(tops[2] - tops[1]).at.least(52)
      for (const id of [6, 7, 8]) {
        await click(`Safe Player ${id}`)
        expect(received.at(-1)).includes({
          type: 'CHOICE_DECIDE',
          id,
          decision: 'safe'
        })
      }
    }
  })
  it('separates unresolved runners offered the same home destination on a wide field', async () => {
    const state = initial()
    state.phase = 'fieldersChoice'
    state.pendingPlay = {
      outcome: "Fielder's Choice",
      trajectoryAccepted: true,
      fieldersChoice: {
        route: [{ id: 15, point: { x: 0, z: -25 } }],
        runners: [
          { playerId: 7, from: 2, to: 4 },
          { playerId: 8, from: 3, to: 4 }
        ],
        calls: []
      }
    }
    await render(state, null, {
      width: 1200,
      height: 900,
      bases: [0, 1, 2, 3].map(() => ({ x: 600, y: 750 }))
    })
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[aria-label^="Fielder\'s choice decision for"]'
      )
    )
    expect(cards).length(2)
    expect(cards.every(card => card.style.position === 'absolute')).equals(true)
    expect(
      Math.abs(parseFloat(cards[0].style.top) - parseFloat(cards[1].style.top))
    ).at.least(52)
    expect(
      cards.every(
        card => getComputedStyle(card).backgroundColor === 'rgba(0, 0, 0, 0)'
      )
    ).equals(true)
    await click('Safe Player 7')
    expect(received.at(-1)).deep.equals({
      type: 'CHOICE_DECIDE',
      id: 7,
      decision: 'safe',
      generation: 0
    })
    await click('Out Player 8')
    expect(received.at(-1)).deep.equals({
      type: 'CHOICE_DECIDE',
      id: 8,
      decision: 'out',
      generation: 0
    })
  })
  it('separates distinct runner destinations at the default camera projection', async () => {
    const state = initial()
    state.phase = 'fieldersChoice'
    state.pendingPlay = {
      outcome: "Fielder's Choice",
      trajectoryAccepted: true,
      fieldersChoice: {
        route: [{ id: 15, point: { x: 0, z: -25 } }],
        runners: [6, 7, 8].map((playerId, index) => ({
          playerId,
          from: index + 1,
          to: index + 2
        })),
        calls: []
      }
    }
    const width = 800
    const height = 450
    const camera = new PerspectiveCamera()
    applyFieldCamera(camera, {
      width,
      height,
      view: 'home',
      zoom: 1.25,
      tilt: (-11 * Math.PI) / 180,
      heightOffset: 33,
      bottomExtension: 112
    })
    const projection = projectBases(camera, width, height)
    await render(state, null, projection)
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[aria-label^="Fielder\'s choice decision for"]'
      )
    )
    expect(cards).length(3)
    expect(cards.every(card => card.style.position === 'absolute')).equals(true)
    expect(parseFloat(cards[0].style.top) + 44).lessThan(projection.heads![2].y)
    expect(parseFloat(cards[1].style.left) + 68).lessThan(projection.feet![3].x)
    expect(cards.every(card => card.textContent === 'SafeOut')).equals(true)
    for (const id of [6, 7, 8]) {
      await click(`Safe Player ${id}`)
      expect(received.at(-1)).includes({ id, decision: 'safe' })
      await click(`Out Player ${id}`)
      expect(received.at(-1)).includes({ id, decision: 'out' })
    }
  })
  it('offers the selected catches for a putout, including the initial fielder and repeated receivers', async () => {
    const state = initial()
    state.phase = 'fieldersChoice'
    state.pendingPlay = {
      outcome: "Fielder's Choice",
      trajectoryAccepted: true,
      fieldersChoice: {
        route: [15, 13, 15].map(id => ({ id, point: { x: 0, z: -25 } })),
        runners: [
          { playerId: 6, from: 1, to: 2 },
          { playerId: 7, from: 2, to: 3 }
        ],
        calls: [],
        choosingPutout: 6
      }
    }
    const fielder = state.session.gameData.players[15].fullName
    const receiver = state.session.gameData.players[13].fullName
    await render(state)
    expect(document.body.textContent).contains('Who put out Player 6?')
    const title = Array.from(document.querySelectorAll<HTMLElement>('*')).find(
      node =>
        node.childNodes.length === 1 &&
        node.textContent === 'Who put out Player 6?'
    )!
    const optionText = document.querySelector<HTMLElement>(
      `[aria-label="Putout by ${fielder}, fielded ball"]`
    )!.firstElementChild!
    expect(getComputedStyle(optionText).color).equals(
      getComputedStyle(title).color
    )
    await click(`Putout by ${fielder}, fielded ball`)
    expect(received.at(-1)).deep.equals({
      type: 'CHOICE_DECIDE',
      id: 6,
      decision: 'out',
      putout: 0,
      generation: 0
    })
    await click(`Putout by ${fielder}, catch 2`)
    expect(received.at(-1)).deep.equals({
      type: 'CHOICE_DECIDE',
      id: 6,
      decision: 'out',
      putout: 2,
      generation: 0
    })
    await click('Cancel')
    expect(received.at(-1)).deep.equals({
      type: 'CHOICE_CANCEL',
      generation: 0
    })
    state.pendingPlay.fieldersChoice!.runners[1] = {
      playerId: 7,
      from: 2,
      to: 3,
      decision: 'out',
      putout: 1
    }
    await render(state)
    expect(
      document.querySelector(
        `[aria-label="Putout by ${fielder}, fielded ball"]`
      )
    ).equals(null)
    await click(`Putout by ${receiver}, catch 1`)
    expect(received.at(-1)).deep.equals({
      type: 'CHOICE_DECIDE',
      id: 6,
      decision: 'out',
      putout: 1,
      generation: 0
    })
  })
  it('shows independent fielder choice calls for existing runners and none for the safe batter', async () => {
    const state = initial()
    state.phase = 'fieldersChoice'
    state.pendingPlay = {
      outcome: "Fielder's Choice",
      trajectoryAccepted: true,
      fieldersChoice: {
        route: [{ id: 10, point: { x: 0, z: -25 } }],
        runners: [
          { playerId: 6, from: 1, to: 2 },
          { playerId: 7, from: 2, to: 3 },
          { playerId: 8, from: 3, to: 4 }
        ],
        calls: []
      }
    }
    const projection: BaseProjection = {
      width: 1200,
      height: 900,
      bases: [
        { x: 600, y: 700 },
        { x: 750, y: 550 },
        { x: 600, y: 350 },
        { x: 300, y: 550 }
      ]
    }
    await render(state, null, projection)
    const name = (id: number): string =>
      state.session.gameData.players[id].fullName
    expect(
      document.querySelectorAll(
        '[aria-label^="Fielder\'s choice decision for"]'
      )
    ).length(3)
    for (const id of [6, 7, 8]) {
      await click(`Safe ${name(id)}`)
      expect(received.at(-1)).deep.equals({
        type: 'CHOICE_DECIDE',
        id,
        decision: 'safe',
        generation: 0
      })
      await click(`Out ${name(id)}`)
      expect(received.at(-1)).deep.equals({
        type: 'CHOICE_DECIDE',
        id,
        decision: 'out',
        generation: 0
      })
    }
    expect(document.querySelector(`[aria-label="Out ${name(1)}"]`)).equals(null)
    await render(state, null, {
      width: 1200,
      height: 900,
      bases: [
        { x: 600, y: 700 },
        { x: 750, y: 550 },
        { x: 600, y: 350 },
        { x: 300, y: 550 }
      ]
    })
    const home = document.querySelector<HTMLElement>(
      `[aria-label="Fielder's choice decision for ${name(8)}"]`
    )!
    expect(parseFloat(home.style.top)).lessThan(700)
    expect(parseFloat(home.style.left)).greaterThan(0)
    await render(state, null, {
      width: 568,
      height: 292,
      bases: [0, 1, 2, 3].map(() => ({ x: 284, y: 146 }))
    })
    expect(
      document.querySelectorAll(
        '[aria-label^="Fielder\'s choice decision for"]'
      )
    ).length(3)
    await click(`Safe ${name(8)}`)
    expect(received.at(-1)).deep.equals({
      type: 'CHOICE_DECIDE',
      id: 8,
      decision: 'safe',
      generation: 0
    })
    state.pendingPlay.fieldersChoice!.runners[0].decision = 'safe'
    await render(state, null, projection)
    expect(
      document.querySelectorAll(
        '[aria-label^="Fielder\'s choice decision for"]'
      )
    ).length(2)
    state.phase = 'runnerMovement'
    await render(state)
    expect(
      document.querySelectorAll(
        '[aria-label^="Fielder\'s choice decision for"]'
      )
    ).length(0)
  })
  it('offers previous or separate error attribution and cancellation', async () => {
    const state = initial()
    state.phase = 'runnerErrorReuse'
    await render(state)
    expect(document.body.textContent).includes('Was this the same error?')
    await click('Use previous error')
    expect(received.at(-1)).deep.equals({
      type: 'RUNNER_ERROR_REUSE',
      reuse: true
    })
    await click('Record another error')
    expect(received.at(-1)).deep.equals({
      type: 'RUNNER_ERROR_REUSE',
      reuse: false
    })
    await click('Cancel')
    expect(received.at(-1)).deep.equals({ type: 'RUNNER_CANCEL' })
  })
  it('offers the two pitch choices, explains unavailable choices, and cancels error selection', async () => {
    let state = initial()
    state.session.liveData.linescore.offense.first = playerRef(state.session, 2)
    state = scoringReducer(state, {
      type: 'RUNNER_DROP',
      id: 2,
      to: 2,
      decision: 'safe',
      generation: state.generation
    })
    const reason = state
    state = scoringReducer(reason, {
      type: 'RUNNER_REASON',
      reason: 'Wild Pitch'
    })
    await render(state)
    expect(
      document
        .querySelector('[aria-label="Use previous pitch as wild pitch"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    expect(document.body.textContent).includes(
      'No previous ball or strike is available.'
    )
    await click('Add a pitched ball to the count')
    expect(received.at(-1)).deep.equals({ type: 'RUNNER_PITCH', addBall: true })
    await click('Cancel')
    expect(received.at(-1)).deep.equals({ type: 'RUNNER_CANCEL' })
    const pitched = scoringReducer(initial(), { type: 'PITCH', kind: 'called' })
    state.session = pitched.session
    state.runnerAction!.reason = 'Passed Ball'
    await render(state)
    await click('YES')
    await click('NO')
    expect(received.at(-1)).deep.equals({ type: 'RUNNER_PITCH_NEW' })
    await click('YES')
    expect(received.at(-1)).deep.equals({
      type: 'RUNNER_PITCH',
      addBall: false
    })
    await click('Cancel')
    expect(received.at(-1)).deep.equals({ type: 'RUNNER_CANCEL' })
    state.runnerAction!.reason = 'Wild Pitch'
    await render(state)
    await click('Use previous pitch as wild pitch')
    expect(received.at(-1)).deep.equals({
      type: 'RUNNER_PITCH',
      addBall: false
    })
    let walk = initial()
    for (let n = 0; n < 4; n++)
      walk = scoringReducer(walk, { type: 'PITCH', kind: 'ball' })
    state.session = walk.session
    state.runnerAction!.reason = 'Wild Pitch'
    await render(state)
    expect(
      document
        .querySelector('[aria-label="Add a pitched ball to the count"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    expect(document.body.textContent).includes(
      'Finish the current play before adding another pitch.'
    )
    state.runnerAction!.reason = 'Passed Ball'
    await render(state)
    expect(
      document.querySelector('[aria-label="NO"]')?.getAttribute('aria-disabled')
    ).equals('true')
    expect(document.body.textContent).includes(
      'Finish the current play before adding another pitch.'
    )
    state = scoringReducer(reason, {
      type: 'RUNNER_REASON',
      reason: 'Fielding Error'
    })
    await render(state)
    await click('Cancel')
    expect(received.at(-1)).deep.equals({ type: 'RUNNER_CANCEL' })
  })
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
      expect(button.textContent).equals(label)
    }
    await click('Safe')
    await click('Out')
    await click('Back')
    expect(received).deep.equals([
      { type: 'HOME', decision: 'safe' },
      { type: 'HOME', decision: 'out' },
      { type: 'HOME', decision: 'back' }
    ])
    state.session.pending!.movements.find(move => move.playerId === 4)!.force =
      true
    await render(state)
    expect(document.querySelector('[aria-label="Back"]')).equals(null)
  })
  it('shares transparent home placement with FC while keeping dragged-runner placement unchanged', async function () {
    const projection: BaseProjection = {
      width: 402,
      height: 579,
      bases: [
        { x: 201, y: 403 },
        { x: 300, y: 320 },
        { x: 201, y: 250 },
        { x: 100, y: 320 }
      ]
    }
    const state = initial()
    state.phase = 'homeDecision'
    state.session.homeQueue = [8]
    await render(state, null, projection)
    const home = document.querySelector<HTMLElement>(
      '[aria-label="Home plate decision for Player 8"]'
    )!
    const frame = homeDecisionFrame(projection, null, false)!
    expect(home.style.left).equals(`${frame.left}px`)
    expect(home.style.top).equals(`${frame.top}px`)
    const homeLeft = home.style.left
    const homeTop = home.style.top
    expect(home.textContent).equals('SafeOut')
    expect(getComputedStyle(home).backgroundColor).equals('rgba(0, 0, 0, 0)')
    state.phase = 'fieldersChoice'
    state.pendingPlay = {
      outcome: "Fielder's Choice",
      trajectoryAccepted: true,
      fieldersChoice: {
        route: [{ id: 15, point: { x: 0, z: -20 } }],
        runners: [{ playerId: 8, from: 3, to: 4 }],
        calls: []
      }
    }
    await render(state, null, projection)
    const choice = document.querySelector<HTMLElement>(
      '[aria-label="Fielder\'s choice decision for Player 8"]'
    )!
    expect(choice.style.left).equals(homeLeft)
    expect(choice.style.top).equals(homeTop)
    expect(choice.textContent).equals('SafeOut')
    state.phase = 'runnerDecision'
    state.runnerAction = {
      playerId: 8,
      from: 3,
      to: 4,
      origin: 'current',
      returnPhase: 'ready'
    }
    await render(state, null, projection)
    const drag = document.querySelector<HTMLElement>(
      '[aria-label="Runner decision for Player 8"]'
    )!
    expect(drag.style.width).equals('130px')
    expect(drag.style.left).equals('217px')
    expect(drag.style.top).equals('247px')
    expect(drag.textContent).contains('Player 8')
    expect(document.querySelector('[aria-label="Safe"]')!.textContent).equals(
      'SafeAt Home'
    )
  })
  it('waits for the first field projection rather than displaying floating FC cards', async function () {
    const state = initial()
    state.phase = 'fieldersChoice'
    state.pendingPlay = {
      outcome: "Fielder's Choice",
      trajectoryAccepted: true,
      fieldersChoice: {
        route: [],
        runners: [{ playerId: 6, from: 1, to: 2 }],
        calls: []
      }
    }
    await render(state)
    expect(
      document.querySelector('[aria-label^="Fielder\'s choice decision for"]')
    ).equals(null)
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
