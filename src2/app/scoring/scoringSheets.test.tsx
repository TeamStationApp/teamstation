import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { GameStationClient } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  RosterDrag as NativeDrag,
  RosterDragGroup as NativeGroup
} from './RosterDrag.native'
import { scoringPreferences } from './scoringPreferences'
import { ScoringScreen } from './ScoringScreen'
import { playerRef } from './scoringSelectors'
import { DevelopmentScoringStateSource } from './scoringStateSource'
import type { ScoringSessionState } from './scoringTypes'
let root: Root | undefined
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
async function click(label: string): Promise<void> {
  const node = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(node, label).not.equals(null)
  await act(async () => {
    node!.click()
  })
}
async function input(label: string, value: string): Promise<void> {
  const node = document.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`
  )!
  expect(node, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node, value)
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function mount(
  prepare?: (session: ScoringSessionState) => void
): Promise<void> {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  const client = new GameStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.roster = async () => []
  const source = new DevelopmentScoringStateSource()
  source.load = async () => {
    const session = createDevelopmentSession(gameFixture, [], [])
    prepare?.(session)
    return session
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <ScoringScreen
          client={client}
          gameId="g1"
          source={source}
          userId="sheets"
          onExit={() => undefined}
        />
      </ThemeProvider>
    )
  })
}
async function menu(label: string): Promise<void> {
  await click('Open scoring menu')
  await click(label)
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  HTMLCanvasElement.prototype.getContext = getContext
})
describe('scoring slide-up sheets', function () {
  it('edits both lineups and defense, adds local players and commits once with undo', async function () {
    await mount()
    await menu('Set Team Rosters')
    await click('Remove Player 2')
    await click('Add Player 2 to Lineup')
    await click('Move Player 2 Up')
    await click('Move Player 2 Down')
    await click('Add Player')
    await input('New player name', 'Alex Local')
    await click('Create Player')
    await click('Add Alex Local to Lineup')
    await click('Set Defense')
    await click('Clear P')
    expect(
      document
        .querySelector('[aria-label="Save Rosters"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    await click('Select Player 1')
    await click('Assign Player 1 to P')
    await click('Home Team')
    expect(document.body.textContent).includes('Hawks')
    await click('Set Lineup')
    await click('Remove Player 9')
    await click('Away Team')
    await click('Save Rosters')
    expect(
      document.querySelector('[aria-label="Undo Set team roster"]')
    ).not.equals(null)
    await click('Undo Set team roster')
    await menu('Set Team Rosters')
    expect(document.body.textContent).not.includes('Alex Local')
    await click('Cancel')
    expect(document.querySelector('[aria-label="Nothing to undo"]')).not.equals(
      null
    )
  })
  it('validates override fields and player collisions, then reconciles the chosen half', async function () {
    await mount()
    await menu('Overrides')
    await input('balls', '4')
    expect(
      document
        .querySelector('[aria-label="Apply Override"]')
        ?.getAttribute('aria-disabled')
    ).equals('true')
    await input('balls', '')
    await input('balls', '3')
    await click('First base')
    await click('Choose First base Player 1')
    expect(document.body.textContent).includes('cannot include the batter')
    await click('First base')
    await click('Choose First base Empty')
    await click('Bottom')
    await click('Batter')
    await click('Choose Batter Player 2')
    await click('Pitcher')
    await click('Choose Pitcher Player 3')
    await input('inning', '2')
    await input('homeScore', '5')
    await input('awayScore', '4')
    await input('outs', '2')
    await input('strikes', '1')
    await click('Apply Override')
    expect(document.body.textContent).includes('Owls 4 · Hawks 5 · Bottom 2nd')
    await click('Undo Override game state')
    expect(document.body.textContent).includes('Owls 0 · Hawks 0 · Top 1st')
    await menu('Overrides')
    await click('Dismiss sheet')
  })
  it('controls device help and confirms half endings, while pending plays disable destructive sheets', async function () {
    await mount()
    await menu('Settings')
    await click('Toggle switch-hitter help')
    await click('Reset shown count')
    expect(await scoringPreferences.read('sheets')).deep.equals({
      help: false,
      shown: 0
    })
    await click('Cancel')
    await menu('End Half Inning')
    await click('Cancel')
    expect(document.body.textContent).includes('Top 1st')
    await menu('End Half Inning')
    await click('Confirm End Half Inning')
    expect(document.body.textContent).includes('Bottom 1st')
    await click('Undo End half inning')
    for (let pitch = 0; pitch < 3; pitch++) await click('Called Strike')
    await click('Open scoring menu')
    for (const label of ['Overrides', 'Set Team Rosters', 'End Half Inning'])
      expect(
        document
          .querySelector(`[aria-label="${label}"]`)
          ?.getAttribute('aria-disabled')
      ).equals('true')
    await click('Resume Game')
    await menu('Settings')
    await click('Cancel')
    await menu('Exit Current Game')
    await click('Cancel')
  })
  it('repairs an occupied next batter explicitly through the roster sheet', async function () {
    await mount(session => {
      session.liveData.boxscore.teams.away.battingOrder = [1]
      session.liveData.linescore.offense.first = playerRef(session, 1)
      session.liveData.plays.currentPlay = null
    })
    expect(document.body.textContent).includes('Next batter is on base')
    await menu('Set Team Rosters')
    await click('Add Player 2 to Lineup')
    await click('Next batter Player 2')
    await click('Save Rosters')
    expect(
      document.querySelector('[aria-label*="Batter Player 2"]')
    ).not.equals(null)
    await click('Undo Set team roster')
    expect(document.body.textContent).includes('Next batter is on base')
    await menu('Overrides')
    await click('First base')
    await click('Choose First base Empty')
    await click('Batter')
    await click('Choose Batter Player 1')
    await click('Apply Override')
    expect(
      document.querySelector('[aria-label*="Batter Player 1"]')
    ).not.equals(null)
  })
  it('cancels roster pointer gestures and commits only a released drop', async function () {
    await mount()
    await menu('Set Team Rosters')
    await click('Remove Player 2')
    const source = document.querySelector<HTMLElement>(
      '[data-roster-target="roster"] [data-roster-player="2"]'
    )!
    const target = document.querySelector<HTMLElement>(
      '[data-roster-target="lineup-0"]'
    )!
    // Save the host method only for restoration.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const hitTest = document.elementsFromPoint
    document.elementsFromPoint = () => [target]
    const pointer = async (type: string, x: number): Promise<void> => {
      await act(async () => {
        const event = new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: 10
        })
        Object.defineProperty(event, 'pointerId', { value: 1 })
        source.dispatchEvent(event)
      })
    }
    try {
      await pointer('pointerdown', 0)
      await pointer('pointermove', 50)
      await pointer('pointercancel', 50)
      expect(target.textContent).includes('1. Player 1')
      await pointer('pointerdown', 0)
      await pointer('pointermove', 50)
      await pointer('pointerup', 50)
      expect(
        document.querySelector('[data-roster-target="lineup-0"]')!.textContent
      ).includes('1. Player 2')
    } finally {
      document.elementsFromPoint = hitTest
    }
    await click('Cancel')
  })
  it('renders the native fallback for the web-only gesture host', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <NativeGroup>
          <NativeDrag>
            <Text>Roster</Text>
          </NativeDrag>
        </NativeGroup>
      )
    })
    expect(host.textContent).equals('Roster')
  })
})
