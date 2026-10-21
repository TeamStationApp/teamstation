import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asRosterEntry } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { EditRosterList } from './EditRosterList'
import { gameFixture } from './isUnscoredGame.test'
import { RosterEditor, type RosterEditorDraft } from './RosterEditor'
import { initialScoringState } from './scoringMachine'
import type { EditRosterRow } from './scoringRosterEdit'
const row = (id: number, jersey: string): EditRosterRow => ({
  id,
  key: `player:${id}`,
  userId: id > 0 ? userIdOfGumbo(id) : undefined,
  name: 'Mookie Betts',
  navigationTitle: 'Mookie B',
  sortName: 'Mookie Betts',
  jersey,
  bats: 'switch',
  throws: 'left',
  positions: ['P', 'SS', 'CF']
})
describe('Roster tab cards and selector', function () {
  it('keeps the coach switch separate from player settings and omits it for guests and scorekeepers', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let edited = 0
    const toggles: Array<[string, boolean]> = []
    const render = async (coach: boolean): Promise<void> => {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <EditRosterList
              rows={[row(1, '1'), { ...row(2, '2'), userId: undefined }]}
              onEdit={() => {
                edited++
              }}
              onEditLocal={() => {
                edited++
              }}
              unrostered={[]}
              onRosteredChange={
                coach
                  ? (id, value) => {
                      toggles.push([id, value])
                    }
                  : undefined
              }
            />
          </ThemeProvider>
        )
      })
    }
    try {
      await render(true)
      const switches = host.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]'
      )
      expect(switches).length(1)
      const player = host.querySelector<HTMLElement>(
        '[aria-label*="Mookie Betts,"]'
      )!
      const card = player.parentElement!
      expect(card.contains(switches[0])).equals(true)
      expect(player.contains(switches[0])).equals(false)
      expect(window.getComputedStyle(card).borderTopWidth).equals('1px')
      expect(window.getComputedStyle(card).alignItems).equals('center')
      expect(window.getComputedStyle(player).borderTopWidth).equals('0px')
      expect(switches[0].checked).equals(true)
      expect(switches[0].getAttribute('aria-label')).equals(
        'Rostered for this game'
      )
      await act(async () => {
        switches[0].click()
      })
      expect(toggles).deep.equals([[userIdOfGumbo(1), false]])
      expect(edited).equals(0)
      await act(async () => {
        host
          .querySelector<HTMLElement>('[aria-label*="Mookie Betts,"]')!
          .click()
      })
      expect(edited).equals(1)
      expect(toggles).length(1)
      await render(false)
      expect(host.querySelectorAll('input[type="checkbox"]')).length(0)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('uses the staff team once roles finish loading and preserves chosen or retained sides', async function () {
    const state = initialScoringState(scoringSession(gameFixture))
    for (const scenario of ['default', 'chosen', 'retained'] as const) {
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      const retained: RosterEditorDraft | undefined =
        scenario === 'retained'
          ? { draft: state.session, side: 'away', mode: 'editRoster' }
          : undefined
      const renderEditor = async (loading: boolean): Promise<void> => {
        await act(async () => {
          root.render(
            <ThemeProvider>
              <RosterEditor
                state={state}
                defaultSide={loading ? undefined : 'home'}
                rosterLoading={loading}
                initialDraft={retained}
                onSave={() => undefined}
              />
            </ThemeProvider>
          )
        })
      }
      try {
        await renderEditor(true)
        if (scenario === 'chosen') {
          await act(async () => {
            host.querySelector<HTMLElement>('[aria-label="Away Team"]')!.click()
          })
        }
        await renderEditor(false)
        const selected = scenario === 'default' ? 'Home Team' : 'Away Team'
        expect(
          host
            .querySelector(`[aria-label="${selected}"]`)
            ?.getAttribute('aria-selected'),
          scenario
        ).equals('true')
        // Refreshing metadata never resets the established selection.
        await renderEditor(true)
        await renderEditor(false)
        expect(
          host
            .querySelector(`[aria-label="${selected}"]`)
            ?.getAttribute('aria-selected'),
          scenario
        ).equals('true')
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    }
  })
  it('keeps badges fixed, exposes hands and actions, and provides empty/loading/error states', async function () {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let selected: string | undefined
    let local: number | undefined
    let retried = false
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <EditRosterList
              rows={[
                row(1, '1'),
                row(2, '12'),
                row(3, '100'),
                { ...row(-1, ''), userId: undefined }
              ]}
              onEdit={id => {
                selected = id
              }}
              onEditLocal={id => {
                local = id
              }}
            />
          </ThemeProvider>
        )
      })
      for (const element of host.querySelectorAll<HTMLElement>(
        '[data-testid^="Jersey badge"]'
      )) {
        expect(element.style.width).equals('56px')
        expect(element.style.height).equals('56px')
        expect(element.style.flexShrink).equals('0')
      }
      expect(host.textContent)
        .includes('#100')
        .and.includes('B:S · T:L · P · SS · CF')
        .and.includes('Game-only player')
      await act(async () => {
        host.querySelector<HTMLElement>('[aria-label*="jersey 12"]')!.click()
      })
      expect(selected).equals(userIdOfGumbo(2))
      await act(async () => {
        host
          .querySelector<HTMLElement>('[aria-label*="game-only player"]')!
          .click()
      })
      expect(local).equals(-1)
      await act(async () => {
        root.render(
          <ThemeProvider>
            <EditRosterList rows={[]} loading />
          </ThemeProvider>
        )
      })
      expect(
        host.querySelector<HTMLElement>('[aria-label="Loading team roster"]')
      ).not.equals(null)
      await act(async () => {
        root.render(
          <ThemeProvider>
            <EditRosterList
              rows={[]}
              error="Unable to refresh roster"
              onRetry={() => {
                retried = true
              }}
            />
          </ThemeProvider>
        )
      })
      expect(host.textContent)
        .includes('No players on this team.')
        .and.includes('Unable to refresh roster')
      await act(async () => {
        host
          .querySelector<HTMLElement>('[aria-label="Retry loading roster"]')!
          .click()
      })
      expect(retried).equals(true)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('edits a game-only roster card and cancels without changing its retained draft', async function () {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const state = initialScoringState(scoringSession(gameFixture))
    const id = state.session.liveData.boxscore.teams.away.players[0]
    let saved: typeof state.session | undefined
    let openedAccount = false
    const click = async (label: string): Promise<void> => {
      await act(async () => {
        document
          .querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)
          .item(document.querySelectorAll(`[aria-label="${label}"]`).length - 1)
          .click()
      })
    }
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <RosterEditor
              state={state}
              canEditTeams={{ [state.session.gameData.teams.away.id]: false }}
              rosters={{
                [state.session.gameData.teams.away.id]: [
                  asRosterEntry({
                    userId: userIdOfGumbo(100),
                    gumboId: 100,
                    shortName: 'Mookie B',
                    jersey: '1',
                    positions: [],
                    isPlayer: true,
                    role: 'member',
                    section: 'player',
                    staffRoles: [],
                    inheritedFrom: null
                  })
                ]
              }}
              onEditPlayer={() => {
                openedAccount = true
              }}
              onSave={draft => {
                saved = draft
              }}
            />
          </ThemeProvider>
        )
      })
      await click('Roster')
      const account = host.querySelector<HTMLElement>(
        '[aria-label^="Mookie B,"]'
      )!
      expect(account.getAttribute('aria-disabled')).equals('true')
      await act(async () => {
        account.click()
      })
      expect(openedAccount).equals(false)
      const card = (): HTMLElement =>
        host.querySelector<HTMLElement>('[aria-label*="game-only player"]')!
      await act(async () => {
        card().click()
      })
      expect(document.body.textContent).includes('Edit Player')
      await click('Cancel')
      expect(document.querySelector('[aria-label="Save Player"]')).equals(null)
      await act(async () => {
        card().click()
      })
      const input = document.querySelector<HTMLInputElement>(
        '[aria-label="First Name"]'
      )!
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(input, 'Jose')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      for (const loading of [true, false]) {
        await act(async () => {
          root.render(
            <ThemeProvider>
              <RosterEditor
                state={state}
                rosterLoading={loading}
                onSave={draft => {
                  saved = draft
                }}
              />
            </ThemeProvider>
          )
        })
        expect(
          document.querySelector<HTMLInputElement>('[aria-label="First Name"]')!
            .value
        ).equals('Jose')
      }
      await click('Save Player')
      await click('Save Rosters')
      expect(saved!.gameData.players[id].firstName).equals('Jose')
      expect(saved!.liveData.boxscore).deep.equals(
        state.session.liveData.boxscore
      )
      expect(state.session.gameData.players[id].firstName).not.equals('Jose')
      await act(async () => {
        root.render(
          <ThemeProvider>
            <RosterEditor
              state={{ ...state, readOnly: true }}
              initialDraft={{
                draft: state.session,
                side: 'away',
                mode: 'editRoster',
                scrollOffsets: {}
              }}
              onSave={() => undefined}
            />
          </ThemeProvider>
        )
      })
      expect(card().getAttribute('aria-disabled')).equals('true')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('starts in lineup and retains the draft across all three modes and teams', async function () {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const state = initialScoringState(scoringSession(gameFixture))
    let saved: unknown
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <RosterEditor
              state={state}
              onSave={draft => {
                saved = draft
              }}
            />
          </ThemeProvider>
        )
      })
      const click = async (label: string): Promise<void> => {
        await act(async () => {
          host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click()
        })
      }
      expect(
        host
          .querySelector('[aria-label="Lineup"]')
          ?.getAttribute('aria-selected')
      ).equals('true')
      for (const mode of ['Roster', 'Defense', 'Lineup']) await click(mode)
      await click('Home Team')
      await click('Roster')
      expect(host.textContent).includes('Tap player to edit.')
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
      // Nothing changed on the way, so Save Rosters stays dim and saves nothing.
      expect(
        host
          .querySelector('[aria-label="Save Rosters"]')
          ?.getAttribute('aria-disabled')
      ).equals('true')
      await click('Save Rosters')
      expect(saved).equals(undefined)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
