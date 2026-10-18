import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { getTheme, ThemeProvider } from '../theme/ThemeContext'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  ROSTER_MODE_LABELS,
  RosterEditor,
  rosterFooterSizes,
  rosterModes
} from './RosterEditor'
import { initialScoringState } from './scoringMachine'
import { ScoringSheetHeight } from './ScoringSheet'

let root: Root | undefined
let host: HTMLDivElement
const render = async (
  element: React.ReactElement,
  sheetHeight?: number
): Promise<void> => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        {sheetHeight == null ? (
          element
        ) : (
          <ScoringSheetHeight.Provider value={sheetHeight}>
            {element}
          </ScoringSheetHeight.Provider>
        )}
      </ThemeProvider>
    )
  })
}
const node = (label: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const click = async (label: string): Promise<void> => {
  const found = node(label)
  expect(found, label).not.equals(null)
  await act(async () => {
    found!.click()
  })
}
const tabs = (): string[] =>
  [...host.querySelectorAll('[role="tab"]')].map(
    tab => tab.getAttribute('aria-label') ?? ''
  )
const testId = (id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const fresh = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(createDevelopmentSession(gameFixture, [], []))
/** The rgb() a browser computes for a #rrggbb colour. */
const rgb = (hex: string): string =>
  `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`

describe('roster screen bottom bar and slider', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
  })
  it('labels the tabs Roster, Lineup and Defense, with Box Score first for a coach', async function () {
    expect(rosterModes('scorekeeper')).deep.equals([
      'editRoster',
      'lineup',
      'defense'
    ])
    expect(rosterModes('coach')).deep.equals([
      'boxScore',
      'editRoster',
      'lineup',
      'defense'
    ])
    expect(ROSTER_MODE_LABELS).deep.equals({
      boxScore: 'Box',
      editRoster: 'Roster',
      lineup: 'Lineup',
      defense: 'Defense'
    })
    await render(<RosterEditor state={fresh()} onSave={() => undefined} />)
    expect(tabs()).deep.equals([
      'Away Team',
      'Home Team',
      'Roster',
      'Lineup',
      'Defense'
    ])
    // The visible words are the accessible names.
    for (const label of ['Roster', 'Lineup', 'Defense'])
      expect(node(label)!.textContent).equals(label)
    expect(node('Lineup')!.getAttribute('aria-selected')).equals('true')
    await act(async () => {
      root!.unmount()
    })
    host.remove()
    await render(
      <RosterEditor
        state={fresh()}
        audience="coach"
        fixedSide="home"
        renderBoxScore={() => <Text>Line score</Text>}
        onSave={() => undefined}
      />
    )
    expect(tabs()).deep.equals(['Box', 'Roster', 'Lineup', 'Defense'])
  })

  it('draws Create Player as green text with no outline, labelled Create Player, opening the player sheet', async function () {
    await render(<RosterEditor state={fresh()} onSave={() => undefined} />)
    const add = node('Create Player')!
    expect(add.getAttribute('role')).equals('button')
    expect(add.textContent).equals('Create Player')
    expect(add.style.borderWidth).equals('')
    expect(add.style.backgroundColor).equals('')
    const words = add.querySelector<HTMLElement>('div[dir], div')!
    const theme = getTheme()
    expect(words.style.color).equals(rgb(theme.successColor))
    expect(words.style.fontFamily).includes(theme.semiBoldTextFont)
    const field = (): Element | null =>
      document.querySelector('[aria-label="First Name"]')
    expect(field()).equals(null)
    await click('Create Player')
    expect(field()).not.equals(null)
    const close = [
      ...document.querySelectorAll<HTMLElement>('[aria-label="Cancel"]')
    ].at(-1)!
    await act(async () => {
      close.click()
    })
    expect(field()).equals(null)
  })

  it('hides the microphone when the server does not dictate', async function () {
    await render(<RosterEditor state={fresh()} onSave={() => undefined} />)
    expect(testId('Roster mic')).equals(null)
    // Create Player and Save Rosters each keep half of the bar.
    const bar = testId('Roster footer bar')!
    expect(bar.children).length(2)
  })

  it('centres a round microphone, twelve points taller than Save Rosters', async function () {
    expect(rosterFooterSizes(false, false)).deep.equals({ save: 36, mic: 48 })
    expect(rosterFooterSizes(true, false)).deep.equals({ save: 36, mic: 48 })
    expect(rosterFooterSizes(true, true)).deep.equals({ save: 28, mic: 40 })
    await render(
      <RosterEditor
        state={fresh()}
        dictationAvailable
        onSave={() => undefined}
      />
    )
    const bar = testId('Roster footer bar')!
    const [left, mic, right] = [...bar.children] as HTMLElement[]
    expect(mic.getAttribute('data-testid')).equals('Roster mic')
    expect(left.style.flexGrow).equals('1')
    expect(right.style.flexGrow).equals('1')
    expect(bar.style.alignItems).equals('center')
    expect(node('Save Rosters')!.style.minHeight).equals('36px')
    expect(mic.style.width).equals('48px')
    expect(mic.style.height).equals('48px')
    expect(mic.style.borderTopLeftRadius).equals('24px')
    expect(mic.querySelector('[aria-label]')).equals(null)
    await act(async () => {
      root!.unmount()
    })
    host.remove()
    // A short sheet shrinks the Defense tab's Save, and the microphone with it.
    await render(
      <RosterEditor
        state={fresh()}
        dictationAvailable
        onSave={() => undefined}
      />,
      260
    )
    await click('Defense')
    expect(node('Save Rosters')!.style.minHeight).equals('28px')
    expect(testId('Roster mic')!.style.width).equals('40px')
  })

  it('draws dictation’s own control in the microphone’s place, and its chat above the tabs', async function () {
    await render(
      <RosterEditor
        state={fresh()}
        dictation={{
          control: <Text accessibilityLabel="Round control">mic</Text>,
          chat: <Text accessibilityLabel="Roster chat">said</Text>
        }}
        onSave={() => undefined}
      />
    )
    const mic = testId('Roster mic')!
    expect(mic.style.width).equals('48px')
    expect(mic.querySelector('[aria-label="Round control"]')).not.equals(null)
    const chat = node('Roster chat')!
    const top = testId('Roster editor top')!
    expect(
      chat.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
  })

  it('lights Save Rosters only while the draft differs from the game', async function () {
    const state = fresh()
    const order = state.session.liveData.boxscore.teams.away.battingOrder
    const last = state.session.gameData.players[order.at(-1)!].fullName
    const first = state.session.gameData.players[order[0]].fullName
    let saved = 0
    await render(
      <RosterEditor
        state={state}
        defaultSide="away"
        onSave={() => {
          saved++
        }}
      />
    )
    const disabled = (): string | null =>
      node('Save Rosters')!.getAttribute('aria-disabled')
    expect(disabled()).equals('true')
    // Taking the last batter out changes the lineup; putting him back at the
    // end restores it, by hand, and Save dims again.
    await click(`Remove ${last}`)
    expect(disabled()).equals(null)
    await click(`Add ${last} to Lineup`)
    expect(disabled()).equals('true')
    await click('Save Rosters')
    expect(saved).equals(0)
    // The first batter put back at the end is a new order.
    await click(`Remove ${first}`)
    await click(`Add ${first} to Lineup`)
    expect(disabled()).equals(null)
    await click('Save Rosters')
    expect(saved).equals(1)
  })

  it('lights Save Rosters with no change while the lineup is not yet accepted, and saves it as it stands', async function () {
    const state = fresh()
    const order = state.session.liveData.boxscore.teams.away.battingOrder
    const last = state.session.gameData.players[order.at(-1)!].fullName
    const saved: number[][] = []
    await render(
      <RosterEditor
        state={state}
        defaultSide="away"
        unaccepted
        onSave={draft => {
          saved.push([...draft.liveData.boxscore.teams.away.battingOrder])
        }}
      />
    )
    const disabled = (): string | null =>
      node('Save Rosters')!.getAttribute('aria-disabled')
    expect(disabled()).equals(null)
    // A change made and undone by hand leaves it lit.
    await click(`Remove ${last}`)
    await click(`Add ${last} to Lineup`)
    expect(disabled()).equals(null)
    await click('Save Rosters')
    expect(saved).deep.equals([order])
  })

  it('keeps Save Rosters dim for a lineup not yet accepted that does not validate', async function () {
    const state = fresh()
    const defense = state.session.liveData.boxscore.teams.away.defense
    // One player at two positions: there is no defense to accept.
    defense.C = defense.P
    await render(
      <RosterEditor
        state={state}
        defaultSide="away"
        unaccepted
        onSave={() => undefined}
      />
    )
    expect(node('Save Rosters')!.getAttribute('aria-disabled')).equals('true')
  })
})
