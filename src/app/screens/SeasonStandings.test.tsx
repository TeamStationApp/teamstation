import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asStandingsRow, type StandingsRow } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { seasonStandingColumns, SeasonStandings } from './SeasonStandings'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
const standing = (teamKind?: string): StandingsRow =>
  asStandingsRow({
    teamId: 'team_demo',
    teamName: 'Demo Placeholder With A Long Name',
    w: 2,
    l: 1,
    t: 1,
    played: 4,
    runsFor: 20,
    runsAgainst: 10,
    winningPct: 0.625,
    runDifferential: 10,
    logoUrl: null,
    ...(teamKind == null ? {} : { teamKind }),
    gamesBehind: 0.5,
    streak: 'W1',
    home: { w: 2, l: 0, t: 0 },
    away: { w: 0, l: 1, t: 1 }
  })
async function mount(
  rows: Array<ReturnType<typeof standing>>,
  onOpen?: (id: string) => void
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <SeasonStandings rows={rows} onOpen={onOpen} />
      </ThemeProvider>
    )
  })
}
describe('season standings placeholder column', () => {
  it('keeps PH last, flags identity and formats records without hiding ties', () => {
    expect(seasonStandingColumns.map(c => c.label)).deep.equals([
      'W',
      'L',
      'T',
      '%',
      'GB',
      'RS',
      'RA',
      'Diff',
      'Streak',
      'Home',
      'Away',
      'PH'
    ])
    const values = seasonStandingColumns.map(c => c.value(standing('external')))
    expect(values).deep.equals([
      '2',
      '1',
      '1',
      '.625',
      '0.5',
      '20',
      '10',
      '+10',
      'W1',
      '2–0',
      '0–1–1',
      '✓'
    ])
    const ph = seasonStandingColumns.at(-1)!
    for (const kind of ['full', undefined]) {
      expect(ph.value(standing(kind))).equals('')
      expect(ph.accessibilityValue!(standing(kind))).equals('Full team')
    }
    expect(ph.accessibilityValue!(standing('external'))).equals(
      'Placeholder team'
    )
    const empty = {
      ...standing(),
      winningPct: null,
      gamesBehind: null,
      streak: null,
      home: undefined,
      away: undefined,
      runDifferential: -2
    }
    expect(
      seasonStandingColumns.map(c => c.value(empty as unknown as StandingsRow))
    ).includes.members(['—', '-2'])
  })
  it('removes the name pill, exposes the flag and preserves navigation and legend', async () => {
    let opened = ''
    await mount([standing('external')], id => {
      opened = id
    })
    expect(document.body.textContent).includes('PH means placeholder team.')
    expect(
      document.querySelector('[aria-label="Placeholder team"]')?.textContent
    ).equals('✓')
    const name = document.querySelector<HTMLElement>(
      '[aria-label="Open Demo Placeholder With A Long Name"]'
    )!
    expect(name.textContent).not.includes('PlaceholderPlaceholder')
    expect(name.querySelector('[aria-label="Placeholder team"]')).equals(null)
    await act(async () => {
      name.click()
    })
    expect(opened).equals('team_demo')
  })
  it('keeps the key for empty standings and full-team flags blank without row actions', async () => {
    await mount([])
    expect(document.body.textContent).includes('PH means placeholder team.')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SeasonStandings rows={[standing()]} />
        </ThemeProvider>
      )
    })
    expect(
      document.querySelector('[aria-label="Full team"]')?.textContent
    ).equals('')
    expect(document.querySelector('[aria-label^="Open "]')).equals(null)
  })
})
