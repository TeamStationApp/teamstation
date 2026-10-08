import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { DEFENSE_LOCATIONS, DefensiveField } from './DefensiveField'
import { RosterDragGroup } from './RosterDrag'
import { POSITIONS } from './scoringTypes'

describe('compact defensive field', function () {
  it('keeps every position in a scrollable field on short screens and clears assigned cards', async function () {
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
      expect(
        host.querySelector('[aria-label="Defensive positions"]')
      ).not.equals(null)
      expect(
        host.querySelector<HTMLElement>('[data-testid="Defensive field"]')!
          .style.height
      ).equals('240px')
      expect(Object.keys(DEFENSE_LOCATIONS).sort()).deep.equals(
        [...POSITIONS].sort()
      )
      expect(host.querySelectorAll('[data-roster-target^="defense-"]')).length(
        9
      )
      await act(async () => {
        host.querySelector<HTMLElement>('[aria-label="Clear P"]')!.click()
      })
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
