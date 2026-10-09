import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient, TeamSummary } from '../../common/api'
import {
  type FixtureSeason,
  NEXT_ROW,
  TEAM_ID,
  TEAM_NAME,
  teamScheduleAnswer
} from '../../test/teamScheduleFixture'
import { ThemeProvider } from '../theme/ThemeContext'
import { TeamScreen } from './TeamScreen'

/**
 * The team's own schedule: the nav bar schedule's rows, one line each, in the
 * order the season is played. The fixture is the one the end-to-end tests
 * serve, so a row here is the row a phone draws.
 */
let root: Root | undefined
let host: HTMLElement | undefined

const NOW = Date.now()

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A client that answers from the fixture, as the fixture's server does. */
function fixtureClient(season: FixtureSeason = 'normal'): TeamStationClient {
  const get = (path: string): unknown =>
    teamScheduleAnswer('GET', `/api/v1${path}`, NOW, undefined, season).body
  return {
    teamGames: async (teamId: string) => get(`/teams/${teamId}/games`),
    roster: async (teamId: string) => get(`/teams/${teamId}/roster`),
    teamStats: async (teamId: string) => get(`/teams/${teamId}/stats`),
    teamPitchingStats: async (teamId: string) =>
      get(`/teams/${teamId}/stats?kind=pitching`),
    standings: async (seasonId: string) =>
      get(`/seasons/${seasonId}/standings`),
    invites: async () => get('/invites')
  } as unknown as TeamStationClient
}

const TEAM: TeamSummary = {
  id: TEAM_ID,
  name: TEAM_NAME,
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: null,
  kind: 'full'
}

interface Opened {
  gameId: string
  title: string
  options?: { autoPlay?: boolean }
}

async function mount(
  season: FixtureSeason = 'normal',
  initialTab = 'schedule'
): Promise<Opened[]> {
  const opened: Opened[] = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <TeamScreen
          client={fixtureClient(season)}
          team={TEAM}
          initialTab={initialTab}
          onOpenGame={(gameId, title, options) => {
            opened.push({ gameId, title, options })
          }}
        />
      </ThemeProvider>
    )
    await delay(20)
  })
  return opened
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-testid="scheduleGame"]')
]
/** Each row's lines, the way a reader takes them in. */
const linesOf = (row: HTMLElement): string[] =>
  [...row.querySelectorAll('div')]
    .filter(node => node.childElementCount === 0)
    .map(node => node.textContent ?? '')
    .filter(line => line !== '')

describe('a team’s schedule', function () {
  it('draws one row a game, in the order the season is played', async function () {
    await mount()
    const teams = rows().map(row =>
      linesOf(row).find(line => /^(@|vs) /.test(line))
    )
    expect(teams).deep.equals([
      'vs Cranes',
      '@ Bisons',
      'vs Otters',
      '@ Herons',
      'vs Foxes',
      '@ Badgers',
      'vs Hawks',
      '@ Owls',
      'vs Falcons',
      '@ Pelicans',
      'vs Ravens',
      '@ Comets',
      'vs Lynx',
      '@ Marlins'
    ])
  })

  it('says only who it is against, never the team’s own name', async function () {
    await mount()
    for (const row of rows()) {
      expect(row.textContent).not.includes(TEAM_NAME)
    }
    expect(document.body.textContent).includes('14 games, 6 to play')
  })

  it('opens the game it was pressed on, named for both sides', async function () {
    const opened = await mount()
    const away = rows().find(row => linesOf(row).includes('@ Owls'))!
    const home = rows().find(row => linesOf(row).includes(NEXT_ROW))!
    await act(async () => {
      away.querySelector<HTMLElement>('[role="button"]')!.click()
      home.querySelector<HTMLElement>('[role="button"]')!.click()
      await delay(10)
    })
    expect(opened).deep.equals([
      {
        gameId: 'gam_mudcats08',
        title: 'Mudcats @ Owls',
        options: { autoPlay: false }
      },
      {
        gameId: 'gam_mudcats09',
        title: 'Mudcats vs Falcons',
        options: { autoPlay: false }
      }
    ])
  })

  it('plays a game that has a video when it is opened', async function () {
    const opened = await mount()
    const first = rows()[0]
    await act(async () => {
      first.querySelector<HTMLElement>('[role="button"]')!.click()
      await delay(10)
    })
    expect(opened[0]).deep.equals({
      gameId: 'gam_mudcats01',
      title: 'Mudcats vs Cranes',
      options: { autoPlay: true }
    })
  })

  it('scores each finished game from this team’s side', async function () {
    await mount()
    const hawks = rows().find(row => linesOf(row).includes('vs Hawks'))!
    const owls = rows().find(row => linesOf(row).includes('@ Owls'))!
    // At home the Mudcats won 5–2, and away at the Owls lost 3–6: ours first
    // either way, not away–home.
    expect(linesOf(hawks)).includes('W 5\u20132')
    expect(linesOf(owls)).includes('L 3\u20136')
  })

  it('marks a game being played LIVE', async function () {
    await mount('live')
    const owls = rows().find(row => linesOf(row).includes('@ Owls'))!
    expect(owls.textContent).includes('LIVE')
  })

  it('says when there are no games', async function () {
    await mount('empty')
    expect(rows()).deep.equals([])
    expect(document.body.textContent).includes('No games scheduled.')
  })
})
