import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { copyState } from '../../common/scoring/state'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { RosterEditor, type RosterEditorDraft } from './RosterEditor'
import { initialScoringState } from './scoringMachine'

let root: Root | undefined
let host: HTMLDivElement
const node = (label: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const click = async (label: string): Promise<void> => {
  const found = node(label)
  expect(found, label).not.equals(null)
  await act(async () => {
    found!.click()
  })
}
const saveDisabled = (): string | null =>
  node('Save Rosters')!.getAttribute('aria-disabled')

describe('the roster screen for a coach', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
  })
  const state = initialScoringState(scoringSession(gameFixture))
  const home = state.session.liveData.boxscore.teams.home
  const name = (id: number): string =>
    state.session.gameData.players[id].fullName
  const mount = async (
    props: {
      initialDraft?: RosterEditorDraft
      onReload?: () => void
      onSave?: () => void
      onCancel?: () => void
    } = {}
  ): Promise<void> => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterEditor
            state={state}
            audience="coach"
            fixedSide="home"
            renderBoxScore={() => <Text>Line score here</Text>}
            initialDraft={props.initialDraft}
            onReload={props.onReload}
            onCancel={props.onCancel}
            onSave={props.onSave ?? (() => undefined)}
          />
        </ThemeProvider>
      )
    })
  }

  it('shows his side alone, with the box score as a tab', async function () {
    await mount({
      initialDraft: {
        draft: copyState(state.session),
        side: 'away',
        mode: 'boxScore'
      }
    })
    expect(node('Away Team')).equals(null)
    expect(node('Home Team')).equals(null)
    expect(node('Box')!.getAttribute('aria-selected')).equals('true')
    expect(host.textContent).includes('Line score here')
    expect(host.querySelector('[aria-label="Batting lineup"]')).not.equals(null)
    // The box score has no instruction and no lineup of its own on show.
    expect(host.textContent).not.includes('Tap to add to lineup.')
    // The footer is on every tab.
    expect(node('Create Player')).not.equals(null)
    await click('Lineup')
    expect(host.textContent).not.includes('Line score here')
    // His own side, though the draft he came back to named the other.
    expect(node(`Remove ${name(home.battingOrder[0])}`)).not.equals(null)
  })

  it('discards a tapped change on Cancel, reloads and is clean again', async function () {
    let reloads = 0
    let cancels = 0
    await mount({
      onReload: () => {
        reloads++
      },
      onCancel: () => {
        cancels++
      }
    })
    const last = name(home.battingOrder.at(-1)!)
    expect(saveDisabled()).equals('true')
    await click(`Remove ${last}`)
    expect(node(`Remove ${last}`)).equals(null)
    expect(saveDisabled()).equals(null)
    await click('Cancel')
    expect(reloads).equals(1)
    expect(cancels).equals(0)
    expect(node(`Remove ${last}`)).not.equals(null)
    expect(saveDisabled()).equals('true')
    // Still on the screen: a coach leaves by the screen's own back chevron.
    expect(node('Lineup')!.getAttribute('aria-selected')).equals('true')
  })

  it('discards a staged change on Cancel too', async function () {
    let reloads = 0
    const staged = copyState(state.session)
    const order = staged.liveData.boxscore.teams.home.battingOrder
    ;[order[0], order[1]] = [order[1], order[0]]
    await mount({
      initialDraft: { draft: staged, side: 'home', mode: 'lineup' },
      onReload: () => {
        reloads++
      }
    })
    expect(saveDisabled()).equals(null)
    await click('Cancel')
    expect(reloads).equals(1)
    expect(saveDisabled()).equals('true')
    expect(
      host.querySelector('[data-roster-target="lineup-0"]')!.textContent
    ).includes(name(home.battingOrder[0]))
  })

  it('explains the roster toggle and offers no lineup QR', async function () {
    await mount()
    await click('Roster')
    expect(host.textContent).includes('Tap player to edit.')
    for (const label of [
      'Share or import team lineup',
      'Share Team Lineup',
      'Scan to Import Team Lineup'
    ])
      expect(node(label), label).equals(null)
    await click('Game roster information')
    expect(document.body.textContent)
      .includes(
        "Toggle a player off to remove them from this current game's roster."
      )
      .and.includes('batting lineup and defensive positions.')
      .and.includes('where all players are rostered by default.')
    await act(async () => {
      document.querySelector<HTMLElement>('[aria-label="Done"]')!.click()
    })
    expect(document.body.textContent).not.includes('Toggle a player off')
  })

  it('keeps the game-only player sheet, as his state is not read-only', async function () {
    expect(state.readOnly).not.equals(true)
    await mount()
    await click('Roster')
    const card = host.querySelector<HTMLElement>(
      '[aria-label*="game-only player"]'
    )!
    expect(card.getAttribute('aria-disabled')).not.equals('true')
    await act(async () => {
      card.click()
    })
    expect(document.body.textContent).includes('Edit Player')
    // His Cancel closes the sheet with the rest of the discarded edits.
    await click('Cancel')
    expect(document.querySelector('[aria-label="Save Player"]')).equals(null)
  })
})
