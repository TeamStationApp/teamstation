import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asBattingRow,
  asGameSummary,
  asPitchingRow,
  asPlayerDetail,
  asRosterEntry,
  type GameStationClient,
  type PlayerStats
} from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { PlayerScreen } from './PlayerScreen'
import { rosterSubtitle, TeamScreen } from './TeamScreen'

/**
 * The whole name is never drawn: not on the player's page, not on the roster.
 * The server no longer sends it, and these pin that the screens would not draw
 * one even if an answer still carried it.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(10)
  })
}

async function press(label: string): Promise<void> {
  // A row's label carries its subtitle after the name, and a filter's
  // choice carries its detail after the label, so a prefix names either.
  const found = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="button"], [role="tab"], [role="radio"]'
    )
  ].find(
    node =>
      (node.getAttribute('aria-label') ?? '').startsWith(label) ||
      (node.textContent ?? '').startsWith(label)
  )
  expect(found, label).not.equals(undefined)
  await act(async () => {
    found!.click()
    await delay(10)
  })
}

const text = (): string => document.body.textContent ?? ''

const jensen = asRosterEntry({
  userId: 7,
  shortName: 'Jensen P',
  // What an older server sent a coach. The cleaner drops it.
  fullName: 'Jensen Puey',
  jersey: '12',
  positions: ['SS', '2B'],
  isPlayer: true,
  role: 'member',
  group: 'player'
})

const batting = asBattingRow({
  userId: 7,
  shortName: 'Jensen P',
  teamId: 'tem_hawks',
  pa: 4,
  ab: 3,
  h: 2,
  singles: 1,
  doubles: 1,
  triples: 0,
  hr: 0,
  bb: 1,
  k: 0,
  hbp: 0,
  rbi: 1,
  rates: { avg: 0.667, obp: 0.75, slg: 1, ops: 1.75 }
})

const pitching = asPitchingRow({
  userId: 7,
  shortName: 'Jensen P',
  teamId: 'tem_hawks',
  ip: '2.0',
  outs: 6,
  bf: 8,
  h: 1,
  hr: 0,
  hbp: 0,
  r: 0,
  bb: 1,
  k: 3,
  rates: { era: 0, whip: 1 }
})

function statsFor(filter: {
  seasonId?: string
  teamId?: string
  year?: number
}): PlayerStats {
  const narrowed = filter.seasonId ?? filter.teamId ?? filter.year
  return {
    userId: 7,
    filter: {
      seasonId: filter.seasonId ?? null,
      teamId: filter.teamId ?? null,
      year: filter.year ?? null
    },
    games: narrowed == null ? 12 : 1,
    batting: narrowed == null ? batting : null,
    pitching: narrowed == null ? pitching : null,
    options: {
      seasons: [{ seasonId: 'sea_1', name: 'Spring 2026', year: 2026 }],
      teams: [{ teamId: 'tem_hawks', name: 'Hawks' }],
      years: [2026]
    }
  }
}

function playerClient(fullName: string | null): GameStationClient {
  return {
    player: async () =>
      asPlayerDetail({
        userId: 7,
        name: 'Jensen P',
        fullName,
        bats: 'left',
        throws: 'right',
        teams: []
      }),
    playerHighlights: async (_id: string, page: { before?: string }) => ({
      highlights: [
        {
          eventId: page.before == null ? 'e1' : 'e2',
          gameId: 'g1',
          videoId: 'v1',
          teamId: 'tem_hawks',
          teamName: 'Hawks',
          outcome: page.before == null ? 'Single' : 'Double',
          title: 'Jensen P singles',
          playAt: '2026-05-02T18:30:00.000Z',
          startOffsetSec: 30,
          playOffsetSec: 33,
          stillUrl: ''
        }
      ],
      nextBefore: page.before == null ? 'cursor' : null,
      withoutVideo: 0
    }),
    playerStats: async (
      _id: string,
      filter: { seasonId?: string; teamId?: string; year?: number }
    ) => statsFor(filter)
  } as unknown as GameStationClient
}

describe('a player’s whole name is never shown', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('is not under the short name, even if an answer carries it', async function () {
    const moments: string[] = []
    await render(
      <PlayerScreen
        client={playerClient('Jensen Puey')}
        userId="7"
        title="Jensen P"
        onOpenMoment={(_game, _video, _at, title) => {
          moments.push(title)
        }}
      />
    )
    expect(text()).includes('Jensen P')
    expect(text()).not.includes('Puey')
    await press('Show more')
    expect(text()).includes('Double')
    await press('Hawks')
    expect(moments.length).equals(1)
  })

  it('is left out with no full name at all, and the rest of the page is the same', async function () {
    const filters: unknown[] = []
    await render(
      <PlayerScreen
        client={playerClient(null)}
        userId="7"
        initialTab="stats"
        onFilter={filter => {
          filters.push(filter)
        }}
      />
    )
    expect(text()).includes('Jensen P')
    expect(text()).not.includes('Jensen Puey')
    expect(text()).includes('12 games')
    await press('Filter')
    await press('Spring 2026')
    await press('Show these')
    expect(text()).includes('No games under this filter.')
    await press('Show every game')
    expect(filters).deep.equals([{ seasonId: 'sea_1' }, {}])
  })

  it('is not in the roster row’s subtitle, which is the positions alone', function () {
    expect(rosterSubtitle(jensen)).equals('SS · 2B')
    expect(rosterSubtitle({ ...jensen, positions: [] })).equals(undefined)
  })

  it('is not on the team’s roster, and a row still opens the player', async function () {
    const opened: number[] = []
    const froms: unknown[] = []
    const client = {
      teamGames: async () => [
        asGameSummary({
          id: 'g1',
          homeTeamId: 'tem_hawks',
          awayTeamId: 'tem_owls',
          homeTeamName: 'Hawks',
          awayTeamName: 'Owls',
          seasonId: 'sea_1',
          startAt: '2026-05-02T18:30:00.000Z',
          venue: null,
          status: 'final',
          homeScore: 3,
          awayScore: 2,
          ingestStatus: 'ok',
          videoCount: 1
        })
      ],
      roster: async () => [
        jensen,
        asRosterEntry({
          userId: 8,
          shortName: 'Coach C',
          jersey: null,
          positions: [],
          isPlayer: false,
          role: 'manager',
          group: 'coach'
        })
      ],
      teamStats: async () => [batting],
      standings: async () => [
        {
          teamId: 'tem_hawks',
          teamName: 'Hawks',
          w: 3,
          l: 1,
          t: 1,
          runsFor: 20,
          runsAgainst: 10,
          played: 5,
          winningPct: 0.7,
          runDifferential: 10
        }
      ]
    } as unknown as GameStationClient
    await render(
      <TeamScreen
        client={client}
        team={{
          id: 'tem_hawks',
          name: 'Hawks',
          shortName: null,
          logoPath: null,
          logoUrl: null,
          record: null
        }}
        initialTab="roster"
        onOpenGame={() => undefined}
        onOpenPlayer={(userId, _name, from) => {
          opened.push(userId)
          froms.push(from)
        }}
      />
    )
    expect(text()).includes('SS · 2B')
    expect(text()).not.includes('Puey')
    expect(text()).includes('#12')
    await press('Jensen P')
    expect(opened).deep.equals([7])
    // The team goes twice: as the Stats filter, and as the team the page was
    // opened for, which a coach's Settings tab edits the player on.
    expect(froms).deep.equals([{ teamId: 'tem_hawks', onTeam: 'tem_hawks' }])
    for (const tab of ['Videos', 'Schedule', 'Stats']) await press(tab)
    expect(text()).includes('Jensen P')
  })
})
