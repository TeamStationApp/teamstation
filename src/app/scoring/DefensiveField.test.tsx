import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { DEFENSE_LOCATIONS, DefensiveField } from './DefensiveField'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { RosterDragGroup } from './RosterDrag'
import { defenseRosterMinimum, RosterEditor } from './RosterEditor'
import { initialScoringState } from './scoringMachine'
import { ScoringSheetHeight } from './ScoringSheet'
import { POSITIONS } from './scoringTypes'

describe('compact defensive field', function () {
  it('reserves a roster row when possible and yields to the complete field for wrapping errors', function () {
    expect(defenseRosterMinimum(0, true)).equals(64)
    expect(defenseRosterMinimum(0, false)).equals(88)
    expect(defenseRosterMinimum(128, true)).equals(64)
    expect(defenseRosterMinimum(111, true)).equals(49)
    expect(defenseRosterMinimum(80, false)).equals(12)
    expect(defenseRosterMinimum(40, true)).equals(0)
  })
  it('uses measured short sheet height to condense controls and retain list space', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <ScoringSheetHeight.Provider value={260}>
              <RosterEditor
                state={initialScoringState(
                  createDevelopmentSession(gameFixture, [], [])
                )}
                onSave={() => undefined}
              />
            </ScoringSheetHeight.Provider>
          </ThemeProvider>
        )
      })
      expect(
        host.querySelector<HTMLElement>('[data-testid="Roster editor top"]')!
          .style.maxHeight
      ).equals('48px')
      expect(
        host.querySelector('[data-testid="Roster selector captions"]')
      ).equals(null)
      expect(
        host.querySelector<HTMLElement>('[aria-label="Cancel"]')!.style
          .minHeight
      ).equals('36px')
      expect(host.querySelector('[aria-label="Batting lineup"]')).not.equals(
        null
      )
      await act(async () => {
        host.querySelector<HTMLElement>('[aria-label="Set Defense"]')!.click()
      })
      expect(
        host.querySelector<HTMLElement>('[data-testid="Roster editor top"]')!
          .style.maxHeight
      ).equals('28px')
      expect(
        host.querySelector<HTMLElement>('[aria-label="Cancel"]')!.style
          .minHeight
      ).equals('28px')
      await act(async () => {
        host.querySelector<HTMLElement>('[aria-label="Clear P"]')!.click()
      })
      expect(
        host.querySelector('[role="alert"]')!.parentElement!.parentElement!
          .textContent
      ).includes('Cancel')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('compacts defense before normal controls can starve the complete field', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const state = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <ScoringSheetHeight.Provider value={400}>
              <RosterEditor
                state={state}
                initialDraft={{
                  draft: state.session,
                  side: 'away',
                  defense: true
                }}
                onSave={() => undefined}
              />
            </ScoringSheetHeight.Provider>
          </ThemeProvider>
        )
      })
      expect(
        host.querySelector<HTMLElement>('[data-testid="Roster editor top"]')!
          .style.maxHeight
      ).equals('28px')
      expect(
        host.querySelector<HTMLElement>('[aria-label="Cancel"]')!.style
          .minHeight
      ).equals('28px')
      expect(host.querySelectorAll('[data-roster-target^="defense-"]')).length(
        9
      )
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
  it('keeps every position in a fixed field and toggles assigned state colors', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let cleared = ''
    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <RosterDragGroup>
              <DefensiveField
                compact
                defense={{ P: 1 }}
                display={() => '#7 Alex Demo'}
                onPlace={() => undefined}
                onClear={position => {
                  cleared = position
                }}
              />
            </RosterDragGroup>
          </ThemeProvider>
        )
      })
      expect(host.querySelector('[aria-label="Defensive positions"]')).equals(
        null
      )
      expect(
        host.querySelector<HTMLElement>('[data-testid="Defensive field"]')!
          .style.height
      ).equals('')
      const pitcher = host.querySelector<HTMLElement>(
        '[data-testid="Defense P card"]'
      )!
      const catcher = host.querySelector<HTMLElement>(
        '[data-testid="Defense C card"]'
      )!
      expect(window.getComputedStyle(pitcher).borderStyle).equals('solid')
      expect(window.getComputedStyle(pitcher).borderColor).equals(
        'rgb(64, 151, 84)'
      )
      expect(window.getComputedStyle(pitcher).backgroundColor).equals(
        'rgb(213, 236, 217)'
      )
      expect(window.getComputedStyle(catcher).borderStyle).equals('dashed')
      expect(window.getComputedStyle(catcher).borderColor).equals(
        'rgb(183, 156, 156)'
      )
      expect(window.getComputedStyle(catcher).backgroundColor).equals(
        'rgb(234, 223, 223)'
      )
      expect(Object.keys(DEFENSE_LOCATIONS).sort()).deep.equals(
        [...POSITIONS].sort()
      )
      expect(host.querySelectorAll('[data-roster-target^="defense-"]')).length(
        9
      )
      await act(async () => {
        host.querySelector<HTMLElement>('[aria-label="Clear P"]')!.click()
      })
      await act(async () => {
        root.render(
          <ThemeProvider>
            <RosterDragGroup>
              <DefensiveField
                defense={{}}
                display={() => '#7 Alex Demo'}
                onPlace={() => undefined}
                onClear={() => undefined}
              />
            </RosterDragGroup>
          </ThemeProvider>
        )
      })
      expect(
        window.getComputedStyle(
          host.querySelector<HTMLElement>('[data-testid="Defense P card"]')!
        ).borderTopStyle
      ).equals('dashed')
      expect(cleared).equals('P')
      expect(
        host.querySelector('[aria-label="Assign C"]')!.textContent
      ).includes('Unassigned')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
