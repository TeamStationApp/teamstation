import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { asRosterEntry } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { createDevelopmentSession } from './developmentSession'
import { EditRosterList } from './EditRosterList'
import { gameFixture } from './isUnscoredGame.test'
import { RosterEditor, type RosterEditorDraft } from './RosterEditor'
import { initialScoringState } from './scoringMachine'
import type { EditRosterRow } from './scoringRosterEdit'
const row = (id: number, jersey: string): EditRosterRow => ({
  id,
  key: `player:${id}`,
  userId: id,
  name: 'Mookie Betts',
  navigationTitle: 'Mookie B',
  sortName: 'Mookie Betts',
  jersey,
  bats: 'switch',
  throws: 'left',
  positions: ['P', 'SS', 'CF']
})
describe('Edit Roster cards and selector', function () {
  it('uses the staff team once roles finish loading and preserves chosen or retained sides', async function () {
    const state = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
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
    let selected: number | undefined
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
      expect(selected).equals(2)
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
    const state = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
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
                    userId: 100,
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
      await click('Edit Roster')
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
    const state = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
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
          .querySelector('[aria-label="Set Lineup"]')
          ?.getAttribute('aria-selected')
      ).equals('true')
      for (const mode of ['Edit Roster', 'Set Defense', 'Set Lineup'])
        await click(mode)
      await click('Home Team')
      await click('Edit Roster')
      expect(host.textContent).includes('Tap a player to edit settings.')
      await click('Save Rosters')
      expect(saved).deep.equals(state.session)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
