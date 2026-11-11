import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { responderDrag } from '../../test/responderDrag'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { OverridesEditor } from './OverridesEditor'
import { initialScoringState } from './scoringMachine'
import type { OverrideDraft, ScoringState } from './scoringTypes'

let root: Root | undefined
let applied: OverrideDraft[]
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})
const stateOf = (): ScoringState =>
  initialScoringState(scoringSession(gameFixture))
async function mount(state = stateOf()): Promise<void> {
  applied = []
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  function Editor(): React.ReactElement {
    const [attempt, setAttempt] = useState(0)
    return (
      <ThemeProvider>
        <OverridesEditor
          onClose={() => undefined}
          state={state}
          applyAttempt={attempt}
          onApply={draft => {
            applied.push(draft)
            setAttempt(value => value + 1)
          }}
        />
      </ThemeProvider>
    )
  }
  await act(async () => {
    root!.render(<Editor />)
  })
}
function node(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[aria-label]')]
    .filter(n => n.getAttribute('aria-label') === label)
    .at(-1)
  expect(found, label).not.equals(undefined)
  return found!
}
async function tap(label: string): Promise<void> {
  await act(async () => {
    node(label).click()
  })
}
async function enter(value: string): Promise<void> {
  const input = node('Enter score') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function wheel(value: string): Promise<void> {
  const rows = [...document.querySelectorAll<HTMLElement>('[role="button"]')]
  const row = rows.find(row => row.textContent === value)
  expect(row, `wheel row ${value}`).not.equals(undefined)
  await act(async () => {
    row!.click()
  })
}

describe('override settings editor', function () {
  it('moves the score wheel window to a valid typed score', async function () {
    const state = stateOf()
    state.session.liveData.linescore.teams.away.runs = 200
    await mount(state)
    await tap('Owls score')
    await enter('5')
    const wheel = node('Owls score: 5')
    expect(
      [...wheel.querySelectorAll<HTMLElement>('div')].map(n => n.scrollTop)
    ).includes(5 * 44)
    await tap('Done')
    await tap('Apply Override')
    expect(applied[0].awayScore).equals(5)
  })
  it('browses score ranges without changing the selected score', async function () {
    const state = stateOf()
    state.session.liveData.linescore.teams.away.runs = 7
    await mount(state)
    await tap('Owls score')
    await tap('Higher scores')
    await tap('Done')
    await tap('Apply Override')
    expect(applied[0].awayScore).equals(7)
    await tap('Owls score')
    await tap('Higher scores')
    await tap('Lower scores')
    await tap('Done')
    await tap('Apply Override')
    expect(applied[1].awayScore).equals(7)
  })

  it('allows a count correction when the batting index is stale', async function () {
    const state = stateOf()
    state.session.liveData.boxscore.teams.away.battingIndex = 3
    await mount(state)
    await tap('Balls 2')
    await tap('Apply Override')
    expect(applied).length(1)
    expect(applied[0]).includes({ balls: 2, batter: 1, batterIndex: 0 })
  })
  it('selects one historical batting occurrence and stages its pinch hitter', async function () {
    const state = stateOf()
    state.session.liveData.boxscore.teams.away.battingOrder = [
      1, 2, 3, 4, 1, 6, 7, 8
    ]
    state.session.liveData.boxscore.teams.away.battingIndex = 4
    const names = state.session.gameData.players
    const label = (id: number, order?: number): string =>
      `${order == null ? '' : `${order}. `}${names[id].fullName}${names[id].jersey === '' ? '' : ` #${names[id].jersey}`}`
    await mount(state)
    await tap('Batter')
    expect(document.querySelectorAll('[aria-label="Current batter"]')).length(1)
    await tap(label(1, 1))
    await tap('Apply Override')
    expect(applied[0]).includes({ batter: 1, batterIndex: 0 })
    await tap('Batter')
    await tap(label(1, 5))
    await tap('Batter')
    await tap(label(9))
    await tap('Apply Override')
    expect(applied[1]).includes({ batter: 1, batterIndex: 4, pinchHitter: 9 })
  })
  it('shows one row per field, bounded count choices and numeric dialogs with cancellation', async function () {
    await mount()
    expect(document.querySelector('[aria-label="Pitcher"]')).equals(null)
    for (const label of ['First base', 'Second base', 'Third base'])
      expect(node(label).textContent).includes('Empty')
    expect(document.querySelector('[aria-label="Correct runners"]')).equals(
      null
    )
    expect(
      node('Apply Override').closest('[data-testid="Scoring sheet footer"]')
    ).not.equals(null)
    for (const [label, max] of [
      ['Balls', 3],
      ['Strikes', 2],
      ['Outs', 2]
    ] as const) {
      expect(node(label).getAttribute('role')).equals('radiogroup')
      expect(node(label).querySelectorAll('[role="radio"]')).length(max + 1)
      await tap(`${label} ${max}`)
      expect(node(`${label} ${max}`).getAttribute('aria-checked')).equals(
        'true'
      )
    }
    await tap('Inning')
    await wheel('50')
    await tap('Cancel')
    expect(node('Inning').textContent).equals('Inning1')
    await tap('Inning')
    await wheel('50')
    await tap('Done')
    expect(node('Inning').textContent).equals('Inning50')
    await tap('Owls score')
    await enter('-1')
    expect(node('Done').getAttribute('aria-disabled')).equals('true')
    for (const invalid of [
      '',
      '1.5',
      '9007199254740992',
      '1e3',
      '0x10',
      '0b11'
    ]) {
      await enter(invalid)
      expect(node('Done').getAttribute('aria-disabled')).equals('true')
    }
    await enter('20')
    const beforeJump = node('Owls score: 20')
    await tap('Go to score')
    expect(node('Owls score: 20')).not.equals(beforeJump)
    const offsets = [
      ...node('Owls score: 20').querySelectorAll<HTMLElement>('div')
    ].map(element => element.scrollTop)
    expect(offsets).includes(20 * 44)
    await enter('1200')
    await tap('Go to score')
    await tap('Higher scores')
    await tap('Lower scores')
    await enter('1200')
    await tap('Done')
    await tap('Hawks score')
    await wheel('5')
    await tap('Done')
    await tap('Apply Override')
    expect(applied[0]).includes({
      inning: 50,
      awayScore: 1200,
      homeScore: 5,
      balls: 3,
      strikes: 2,
      outs: 2
    })
  })
  it('supports horizontal count drags, clamps endpoints and leaves vertical scroll alone', async function () {
    await mount()
    await responderDrag(node('Balls 0'), [
      [10, 10],
      [30, 11],
      [210, 12]
    ])
    expect(node('Balls 3').getAttribute('aria-checked')).equals('true')
    await responderDrag(node('Balls 3'), [
      [210, 10],
      [190, 11],
      [0, 12]
    ])
    expect(node('Balls 0').getAttribute('aria-checked')).equals('true')
    await responderDrag(node('Balls 0'), [
      [10, 10],
      [12, 50],
      [14, 100]
    ])
    await tap('Apply Override')
    expect(applied[0].balls).equals(0)
  })
  it('lists lineup and bench separately, marks the batter and disables every occupied base', async function () {
    const state = stateOf()
    state.session.liveData.boxscore.teams.away.battingOrder.pop()
    const line = state.session.liveData.linescore
    line.offense.first = { id: 2, fullName: 'Player 2' }
    line.offense.second = { id: 3, fullName: 'Player 3' }
    line.offense.third = { id: 4, fullName: 'Player 4' }
    await mount(state)
    await tap('Batter')
    expect(node('Current batter')).not.equals(null)
    for (const base of ['first', 'second', 'third'])
      expect(node(`On ${base} base`)).not.equals(null)
    const names = state.session.gameData.players
    const label = (id: number, order?: number): string =>
      `${order == null ? '' : `${order}. `}${names[id].fullName}${names[id].jersey === '' ? '' : ` #${names[id].jersey}`}`
    expect(node(label(2, 2)).getAttribute('aria-disabled')).equals('true')
    await tap(label(2, 2))
    expect(document.body.textContent).includes('Skip to Batter')
    await tap(label(5, 5))
    await tap('Apply Override')
    expect(applied[0].batter).equals(5)
    await tap('Batter')
    await tap(label(9))
    await tap('Apply Override')
    expect(applied[1]).includes({ batter: 5, pinchHitter: 9 })
    await tap('Batter')
    await tap(label(6, 6))
    await tap('Apply Override')
    expect(applied[2]).includes({ batter: 6, pinchHitter: undefined })
    await tap('Batter')
    await tap('Cancel')
    expect(document.body.textContent).not.includes('Skip to Batter')
  })
  it('changes half, restores context before Apply, handles empty lineups and no bench', async function () {
    await mount()
    await tap('Batter')
    expect(document.body.textContent).includes('No players on the bench.')
    await tap('Cancel')
    await tap('Bottom')
    await tap('Apply Override')
    expect(applied[0]).includes({ top: false, batter: 10, pitcher: null })
    await tap('Top')
    await tap('Apply Override')
    expect(applied[1].pitcher).equals(10)
  })
  it('explains an empty lineup and disables Apply', async function () {
    const state = stateOf()
    state.session.liveData.boxscore.teams.home.battingOrder = []
    await mount(state)
    await tap('Bottom')
    await tap('Batter')
    expect(document.body.textContent).includes(
      "Set the batting team's lineup first."
    )
    await tap('Cancel')
    expect(node('Apply Override').getAttribute('aria-disabled')).equals('true')
    expect(
      document.querySelector('[data-testid="Scoring sheet footer"]')
        ?.textContent
    ).includes('Choose a batter from the batting team lineup.')
  })
})

describe('override settings pinch-hit readiness', function () {
  it('requires a selected lineup slot before staging a bench player', async function () {
    const state = stateOf()
    state.session.liveData.boxscore.teams.away.battingOrder.pop()
    state.session.liveData.linescore.offense.first = {
      id: 1,
      fullName: state.session.gameData.players[1].fullName
    }
    await mount(state)
    await tap('Bottom')
    await tap('Top')
    await tap('Batter')
    const player = state.session.gameData.players[9]
    const label = `${player.fullName}${player.jersey === '' ? '' : ` #${player.jersey}`}`
    expect(node(label).getAttribute('aria-disabled')).equals('true')
    expect(document.body.textContent).includes(
      'Choose a lineup batter before selecting a pinch hitter.'
    )
    await tap(label)
    expect(applied).deep.equals([])
    const eligible = state.session.gameData.players[2]
    await tap(
      `2. ${eligible.fullName}${eligible.jersey === '' ? '' : ` #${eligible.jersey}`}`
    )
    await tap('Batter')
    expect(node(label).getAttribute('aria-disabled')).not.equals('true')
    await tap(label)
    await tap('Apply Override')
    expect(applied[0]).includes({ batter: 2, pinchHitter: 9 })
  })
})

describe('override settings runner corrections', function () {
  it('stages adding, moving and clearing a runner without changing the live game', async function () {
    const state = stateOf()
    const name = state.session.gameData.players[2].fullName
    await mount(state)
    await tap('First base')
    await tap(`Choose First base ${name}`)
    await tap('Second base')
    await tap(`Choose Second base ${name}`)
    await tap('Apply Override')
    expect(applied[0].bases).deep.equals([null, 2, null])
    expect(state.session.liveData.linescore.offense.second).equals(null)
    await tap('Second base')
    await tap('Choose Second base Empty')
    await tap('Apply Override')
    expect(applied[1].bases).deep.equals([null, null, null])
  })
})

describe('override settings transaction errors', function () {
  it('shows the actual read-only refusal and disables Apply', async function () {
    const state = stateOf()
    state.readOnly = true
    await mount(state)
    expect(document.body.textContent).includes('Scoring is read-only')
    expect(node('Apply Override').getAttribute('aria-disabled')).equals('true')
    await tap('Apply Override')
    expect(applied).deep.equals([])
  })
})
