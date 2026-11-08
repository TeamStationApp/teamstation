import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

import { asRosterEntry } from '../../common/api'
import { applyAction } from '../../common/scoring/session'
import { copyState } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { guestRenames } from './guestRenames'
import { gameFixture } from './isUnscoredGame.test'
import { RosterEditor, type RosterEditorDraft } from './RosterEditor'
import { initialScoringState } from './scoringMachine'
import { ScoringSheetHeight } from './ScoringSheet'
import type { ScoringState } from './scoringTypes'

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
      state?: ScoringState
      sheetHeight?: number
      hiddenTeams?: readonly string[]
    } = {}
  ): Promise<void> => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ScoringSheetHeight.Provider value={props.sheetHeight}>
            <RosterEditor
              state={props.state ?? state}
              audience="coach"
              fixedSide="home"
              renderBoxScore={() => <Text>Line score here</Text>}
              hiddenTeams={props.hiddenTeams}
              initialDraft={props.initialDraft}
              onReload={props.onReload}
              onCancel={props.onCancel}
              onSave={props.onSave ?? (() => undefined)}
            />
          </ScoringSheetHeight.Provider>
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
    expect(node('Box Score')!.getAttribute('aria-selected')).equals('true')
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
    // The sheet opens on the roster; the lineup is a tab away.
    await click('Lineup')
    await click(`Remove ${last}`)
    expect(node(`Remove ${last}`)).equals(null)
    expect(saveDisabled()).equals(null)
    // Cancel is on Save Rosters' row, in the footer bar.
    expect(
      host
        .querySelector('[data-testid="Roster footer bar"]')!
        .contains(node('Cancel'))
    ).equals(true)
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

  /** The lineup column's numbered rows, as their player ids. */
  const lineupIds = (): number[] =>
    Array.from(
      host.querySelectorAll(
        '[data-roster-target^="lineup-"][data-roster-player]'
      )
    ).map(each => Number(each.getAttribute('data-roster-player')))
  /** Whether a text node is drawn whole: no ellipsis, no clipped line. */
  const unclipped = (text: string): boolean => {
    const found = Array.from(
      host.querySelectorAll<HTMLElement>('[data-testid="Lineup header"] *')
    ).find(each => each.textContent === text && each.children.length === 0)
    expect(found, text).not.equals(undefined)
    const style = window.getComputedStyle(found!)
    return style.textOverflow !== 'ellipsis' && style.overflow !== 'hidden'
  }

  it('clears his lineup before the first pitch, the players back on the roster (U26)', async function () {
    // A dense sheet still shows the header, both words whole.
    await mount({ sheetHeight: 300 })
    await click('Lineup')
    expect(unclipped('Lineup')).equals(true)
    expect(unclipped('Clear')).equals(true)
    const order = [...home.battingOrder]
    expect(lineupIds()).deep.equals(order)
    await click('Clear Lineup')
    expect(lineupIds()).deep.equals([])
    const roster = host.querySelector('[data-roster-target="roster"]')!
    for (const id of order)
      expect(
        roster.querySelector(`[data-roster-player="${id}"]`),
        name(id)
      ).not.equals(null)
    expect(saveDisabled()).equals(null)
  })

  it('offers no Clear and no removal after the first pitch, and marks the slot that bats (U27)', async function () {
    const pitched = initialScoringState(
      applyAction(state.session, { type: 'pitch', call: 'B' }).state
    )
    await mount({ state: pitched })
    await click('Lineup')
    expect(node('Clear Lineup')).equals(null)
    expect(node(`Remove ${name(home.battingOrder[0])}`)).equals(null)
    // The hosts are due to lead off: the bat is on their first slot.
    const bat = host.querySelector('[data-testid="batIcon"]')!
    expect(bat.getAttribute('aria-label')).equals(
      `${name(home.battingOrder[home.battingIndex])} bats`
    )
    expect(
      bat.closest('[data-roster-target]')!.getAttribute('data-roster-target')
    ).equals(`lineup-${home.battingIndex}`)
    expect(host.querySelectorAll('[data-testid="batIcon"]')).lengthOf(1)
    expect(host.textContent).not.includes('Drop here to remove')
  })
  it('draws a hidden team’s player named in full by his public label, and only that team’s', async function () {
    const named = copyState(state.session)
    const id = named.liveData.boxscore.teams.home.battingOrder[0]
    named.gameData.players[id] = {
      ...named.gameData.players[id],
      fullName: 'Shohei Ohtani',
      nameFormat: 'full',
      compactName: 'Shohei O'
    }
    const homeId = named.gameData.teams.home.id
    const awayId = named.gameData.teams.away.id
    for (const [hidden, shown, gone] of [
      [[homeId], 'Shohei O', 'Ohtani'],
      [[awayId], 'Shohei Ohtani', undefined],
      [[], 'Shohei Ohtani', undefined]
    ] as const) {
      await mount({ state: initialScoringState(named), hiddenTeams: hidden })
      expect(node(`Remove ${shown}`), shown).not.equals(null)
      if (gone != null) expect(host.textContent).not.includes(gone)
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      host.remove()
    }
  })
  it('opens a hidden team’s guest named in full on his public label, and keeps his name when only the jersey changes', async function () {
    const named = copyState(state.session)
    const guestId = named.liveData.boxscore.teams.home.players.find(
      id => named.gameData.players[id].local
    )!
    expect(guestId, 'a game-only player').not.equals(undefined)
    named.gameData.players[guestId] = {
      ...named.gameData.players[guestId],
      firstName: 'Shohei',
      lastName: 'Ohtani',
      fullName: 'Shohei Ohtani',
      nameFormat: 'full',
      compactName: 'Shohei O'
    }
    const drafts: RosterEditorDraft[] = []
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterEditor
            state={initialScoringState(named)}
            audience="coach"
            fixedSide="home"
            hiddenTeams={[named.gameData.teams.home.id]}
            renderBoxScore={() => <Text>Line score here</Text>}
            onDraftChange={draft => drafts.push(draft)}
            onSave={() => undefined}
          />
        </ThemeProvider>
      )
    })
    await click('Roster')
    const card = host.querySelector<HTMLElement>(
      '[aria-label^="Shohei O,"][aria-label*="game-only player"]'
    )
    expect(card, 'the guest by his public label').not.equals(null)
    await act(async () => {
      card!.click()
    })
    const input = (label: string): HTMLInputElement =>
      document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
    expect(input('First Name').value).equals('Shohei')
    expect(input('Last Name').value).equals('O')
    expect(document.body.innerHTML).not.includes('Ohtani')
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input('Jersey Number'), '17')
      input('Jersey Number').dispatchEvent(
        new window.Event('input', { bubbles: true })
      )
    })
    await act(async () => {
      document.querySelector<HTMLElement>('[aria-label="Save Player"]')!.click()
    })
    expect(drafts.at(-1)!.draft.gameData.players[guestId]).include({
      firstName: 'Shohei',
      lastName: 'Ohtani',
      fullName: 'Shohei Ohtani',
      jersey: '17'
    })
    expect(document.body.innerHTML).not.includes('Ohtani')
  })
  it('keeps a guest’s name when his sheet opened on his public label and his name is read in full by the save', async function () {
    const named = copyState(state.session)
    const guestId = named.liveData.boxscore.teams.home.players.find(
      id => named.gameData.players[id].local
    )!
    named.gameData.players[guestId] = {
      ...named.gameData.players[guestId],
      firstName: 'Shohei',
      lastName: 'Ohtani',
      fullName: 'Shohei Ohtani',
      nameFormat: 'full',
      compactName: 'Shohei O'
    }
    const opened = initialScoringState(named)
    const drafts: RosterEditorDraft[] = []
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const render = async (hiddenTeams: readonly string[]): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <RosterEditor
              state={opened}
              audience="coach"
              fixedSide="home"
              hiddenTeams={hiddenTeams}
              renderBoxScore={() => <Text>Line score here</Text>}
              onDraftChange={draft => drafts.push(draft)}
              onSave={() => undefined}
            />
          </ThemeProvider>
        )
      })
    }
    // Every team is hidden while the reader's rights are read again.
    await render([named.gameData.teams.home.id])
    await click('Roster')
    const card = host.querySelector<HTMLElement>(
      '[aria-label^="Shohei O,"][aria-label*="game-only player"]'
    )
    expect(card, 'the guest by his public label').not.equals(null)
    await act(async () => {
      card!.click()
    })
    const input = (label: string): HTMLInputElement =>
      document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
    expect(input('Last Name').value).equals('O')
    // The rights land: his name may be read in full, the sheet still open.
    await render([])
    expect(input('Last Name').value).equals('O')
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input('Jersey Number'), '17')
      input('Jersey Number').dispatchEvent(
        new window.Event('input', { bubbles: true })
      )
    })
    await act(async () => {
      document.querySelector<HTMLElement>('[aria-label="Save Player"]')!.click()
    })
    const saved = drafts.at(-1)!.draft
    expect(saved.gameData.players[guestId]).include({
      firstName: 'Shohei',
      lastName: 'Ohtani',
      fullName: 'Shohei Ohtani',
      jersey: '17'
    })
    expect(guestRenames(named, saved)).deep.equals([])
  })
  it('keeps a guest named in full by his public label when a player is left out', async function () {
    const named = copyState(state.session)
    const guestId = named.liveData.boxscore.teams.home.players.find(
      id => named.gameData.players[id].local
    )!
    expect(guestId, 'a game-only player').not.equals(undefined)
    named.gameData.players[guestId] = {
      ...named.gameData.players[guestId],
      fullName: 'Shohei Ohtani',
      nameFormat: 'full',
      compactName: 'Shohei O'
    }
    const teamId = named.gameData.teams.home.id
    // The rest of the side are his team's roster players.
    const rostered = named.liveData.boxscore.teams.home.players.filter(
      id => id !== guestId
    )
    for (const id of rostered) named.gameData.players[id].local = false
    const rosters = {
      [teamId]: rostered.map(id =>
        asRosterEntry({
          userId: userIdOfGumbo(id),
          gumboId: id,
          shortName: named.gameData.players[id].fullName,
          jersey: named.gameData.players[id].jersey,
          positions: [],
          isPlayer: true,
          role: 'member',
          section: 'player',
          staffRoles: [],
          inheritedFrom: null
        })
      )
    }
    const drafts: RosterEditorDraft[] = []
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <RosterEditor
            state={initialScoringState(named)}
            audience="coach"
            fixedSide="home"
            renderBoxScore={() => <Text>Line score here</Text>}
            rosters={rosters}
            unrostered={{ away: [], home: [] }}
            onRosteredChange={async (side, userId, on) => ({
              away: [],
              home: on ? [] : [rostered[0]]
            })}
            onDraftChange={draft => drafts.push(draft)}
            onSave={() => undefined}
          />
        </ThemeProvider>
      )
    })
    await click('Roster')
    const left = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"][aria-label="Rostered for this game"]'
    )!
    await act(async () => {
      left.click()
    })
    const last = drafts.at(-1)!.draft
    expect(last.liveData.boxscore.teams.home.players).not.include(rostered[0])
    expect(last.gameData.players[guestId]).include({
      fullName: 'Shohei Ohtani',
      nameFormat: 'full',
      compactName: 'Shohei O'
    })
  })

  it('clears his whole defense, the pitcher too, from the red Clear level with Roster (U34)', async function () {
    await mount()
    await click('Defense')
    const header = host.querySelector<HTMLElement>(
      '[data-testid="Defense roster header"]'
    )!
    expect(header.textContent).equals('RosterClear')
    expect(header.style.justifyContent).equals('space-between')
    expect(
      host
        .querySelector('[data-roster-target="defense-P"]')!
        .getAttribute('data-roster-player')
    ).not.equals(null)
    await click('Clear Defense')
    expect(host.querySelectorAll('[data-roster-target^="defense-"]')).lengthOf(
      9
    )
    expect(
      host.querySelectorAll(
        '[data-roster-target^="defense-"][data-roster-player]'
      )
    ).lengthOf(0)
    expect(saveDisabled()).equals(null)
  })
})
