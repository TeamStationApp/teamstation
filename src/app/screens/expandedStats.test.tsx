import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asPlayerDetail,
  asPlayerStats,
  asTeamSummary,
  type TeamStationClient
} from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { PlayerScreen } from './PlayerScreen'
import { battingColumns, pitchingColumns } from './statColumns'
import { battingFixture, pitchingFixture } from './statColumns.test'
import { TeamScreen } from './TeamScreen'

let root: Root | undefined
let host: HTMLElement
const wait = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 20))
}
const team = asTeamSummary({
  id: 'demo-hawks',
  name: 'Demo Hawks',
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: null
})
const stats = asPlayerStats({
  userId: 101,
  filter: { seasonId: null, teamId: null, year: null },
  games: 2,
  batting: battingFixture,
  pitching: pitchingFixture,
  options: { seasons: [], teams: [], years: [] }
})
function client(over: Record<string, unknown> = {}): TeamStationClient {
  return {
    teamGames: async () => [],
    roster: async () => [],
    teamStats: async () => [battingFixture],
    teamPitchingStats: async () => [pitchingFixture],
    player: async () =>
      asPlayerDetail({ userId: 101, name: 'Alex L', teams: [] }),
    playerHighlights: async () => ({
      highlights: [],
      nextBefore: null,
      withoutVideo: 0
    }),
    playerStats: async () => stats,
    ...over
  } as unknown as TeamStationClient
}
async function render(element: React.ReactElement): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await wait()
  })
}
const text = (): string => host.textContent ?? ''
const leaves = (): string[] =>
  [...host.querySelectorAll('*')]
    .filter(n => n.children.length === 0)
    .map(n => n.textContent ?? '')
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
})

describe('expanded statistics screens', function () {
  it('shares compact header and row widths with no leading statistics gutter', async function () {
    await render(
      <TeamScreen
        client={client({
          teamStats: async () => [{ ...battingFixture, pa: 12345 }]
        })}
        team={team}
        initialTab="stats"
        onOpenGame={() => {}}
      />
    )
    const cells = [...host.querySelectorAll<HTMLElement>('*')].filter(
      n => n.children.length === 0
    )
    const header = cells.find(n => n.textContent === 'PA')!
    const value = cells.find(n => n.textContent === '12345')!
    const second = header.nextElementSibling as HTMLElement
    const name = header.previousElementSibling as HTMLElement
    expect(parseFloat(getComputedStyle(name).minWidth)).equals(112)
    expect(getComputedStyle(header).width).equals(getComputedStyle(value).width)
    expect(getComputedStyle(header).paddingLeft).equals('0px')
    expect(getComputedStyle(value).paddingLeft).equals('0px')
    expect(parseFloat(getComputedStyle(second).paddingLeft)).at.most(6)
    expect(getComputedStyle(header.parentElement!).columnGap).not.equals('4px')
    expect(getComputedStyle(value).whiteSpace).equals('nowrap')
  })

  it('renders both team tables with every requested column', async function () {
    await render(
      <TeamScreen
        client={client()}
        team={team}
        initialTab="stats"
        onOpenGame={() => {}}
      />
    )
    expect(text())
      .includes('BATTING')
      .and.includes('PITCHING')
      .and.includes('Blair R')
    for (const column of [...battingColumns, ...pitchingColumns])
      expect(leaves()).includes(column.label)
    expect(text()).includes('66.7%').and.includes('.182')
  })
  it('handles team loading, empty statistics and load errors', async function () {
    await render(
      <TeamScreen
        client={client({
          teamStats: async () => [],
          teamPitchingStats: async () => []
        })}
        team={team}
        initialTab="stats"
        onOpenGame={() => {}}
      />
    )
    expect(text()).includes('No plays have been ingested')
    expect(text()).not.includes('Pitching')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <TeamScreen
            client={client({
              teamGames: async () => {
                throw new Error('Synthetic failure')
              }
            })}
            team={team}
            initialTab="stats"
            onOpenGame={() => {}}
          />
        </ThemeProvider>
      )
      await wait()
    })
    expect(text()).includes('Synthetic failure')
  })
  it('shares player columns and removes the absent pitching card', async function () {
    await render(
      <PlayerScreen client={client()} userId="101" initialTab="stats" />
    )
    for (const column of [...battingColumns, ...pitchingColumns])
      expect(leaves()).includes(column.label)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <PlayerScreen
            client={client({
              playerStats: async () => ({ ...stats, pitching: null })
            })}
            userId="101"
            initialTab="stats"
          />
        </ThemeProvider>
      )
      await wait()
    })
    expect(text()).not.includes('Pitching').and.not.includes('never pitched')
    expect(text()).includes('Batting')
  })
  it('retains the explanation for a pitcher who has not batted', async function () {
    await render(
      <PlayerScreen
        client={client({
          playerStats: async () => ({ ...stats, batting: null })
        })}
        userId="101"
        initialTab="stats"
      />
    )
    expect(text()).includes('Pitching').and.includes('never batted')
  })
})
