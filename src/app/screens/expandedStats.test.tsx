import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGameSummary,
  asPlayerDetail,
  asPlayerStats,
  asTeamSummary,
  type GamesPageQuery,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { pageOfGames } from '../../test/pageOf'
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
  userId: userIdOfGumbo(101),
  filter: { seasonId: null, teamId: null, year: null },
  games: 2,
  batting: battingFixture,
  pitching: pitchingFixture,
  options: { seasons: [], teams: [], years: [] }
})
function client(over: Record<string, unknown> = {}): TeamStationClient {
  return {
    teamGamesPage: async (_id: string, query?: GamesPageQuery) =>
      pageOfGames([], query),
    roster: async () => [],
    teamStats: async () => [battingFixture],
    teamPitchingStats: async () => [pitchingFixture],
    player: async () =>
      asPlayerDetail({ userId: userIdOfGumbo(101), name: 'Alex L', teams: [] }),
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
  it('keeps authorized team statistics usable when optional host standings are absent or private', async function () {
    await render(
      <TeamScreen
        client={client({
          teamGamesPage: async (_id: string, query?: GamesPageQuery) =>
            pageOfGames(
              [
                asGameSummary({
                  id: 'gam_demo_optional_standing',
                  seasonId: 'sea_demo_guest',
                  startAt: '2027-04-01T19:00:00Z',
                  homeTeamId: team.id,
                  awayTeamId: 'tem_demo_opponent',
                  homeTeamName: team.name,
                  awayTeamName: 'Demo Opponent',
                  venue: null,
                  homeScore: null,
                  awayScore: null,
                  ingestStatus: 'none',
                  videoCount: 0,
                  status: 'scheduled'
                })
              ],
              query
            ),
          standings: async () => {
            throw new HttpError('notFound', 'Host standings unavailable')
          }
        })}
        team={team}
        initialTab="stats"
        onOpenGame={() => {}}
      />
    )
    expect(text()).includes('BATTING').and.includes('PITCHING')
    expect(text()).not.includes('Host standings unavailable')
  })
  it('lists a withdrawn line on the team’s tables under its placeholder name', async function () {
    await render(
      <TeamScreen
        client={client({
          teamStats: async () => [
            battingFixture,
            { ...battingFixture, userId: null, shortName: 'RFlcns A' }
          ],
          teamPitchingStats: async () => [
            { ...pitchingFixture, userId: null, shortName: 'RFlcns B' }
          ]
        })}
        team={team}
        initialTab="stats"
        onOpenGame={() => {}}
      />
    )
    expect(text()).includes('RFlcns A').and.includes('RFlcns B')
  })
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
    // The Player heading and the names sit in the column beside the
    // sideways scroll; the figures and their headings scroll inside it.
    const heading = cells.find(n => n.textContent === 'Player')!
    const names = heading.closest('[data-testid="frozen-names"]')
    const figures = header.closest('[data-testid="frozen-figures"]')
    expect(names, 'names column').not.equals(null)
    expect(figures, 'figures').not.equals(null)
    expect(figures!.contains(heading)).equals(false)
    expect(figures!.contains(value)).equals(true)
    expect(header.previousElementSibling).equals(null)
    expect(getComputedStyle(header).width).equals(getComputedStyle(value).width)
    expect(getComputedStyle(header).paddingLeft).equals('0px')
    expect(getComputedStyle(value).paddingLeft).equals('0px')
    expect(parseFloat(getComputedStyle(second).paddingLeft)).at.most(8)
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
      .and.includes('Babe R')
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
              teamGamesPage: async () => {
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
      <PlayerScreen
        client={client()}
        userId={userIdOfGumbo(101)}
        initialTab="stats"
      />
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
            userId={userIdOfGumbo(101)}
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
        userId={userIdOfGumbo(101)}
        initialTab="stats"
      />
    )
    expect(text()).includes('Pitching').and.includes('never batted')
  })
})
