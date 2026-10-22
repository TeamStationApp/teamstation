import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGameSummary,
  asRosterEntry,
  type ScheduleEntry,
  type StaffEntry,
  type TeamStationClient,
  type TeamSummary
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import { staffSubtitle, TeamScreen } from './TeamScreen'

/**
 * U1: the team page for somebody who only follows the team, and the Follow
 * toggle for anybody not on it, against a fake client.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const text = (): string => document.body.textContent ?? ''

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(10)
  })
  await act(async () => {
    await delay(10)
  })
}

function controls(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ]
}

function control(label: string): HTMLElement | undefined {
  return controls().find(
    node =>
      (node.getAttribute('aria-label') ?? '').startsWith(label) ||
      (node.textContent ?? '') === label
  )
}

async function press(label: string): Promise<void> {
  const found = control(label)
  expect(found, label).not.equals(undefined)
  await act(async () => {
    found!.click()
    await delay(10)
  })
}

const tabs = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map(
    node => node.textContent ?? ''
  )

const hawks: TeamSummary = {
  id: 'tem_hawks',
  name: 'Hawks',
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: null,
  kind: 'full',
  canViewPrivate: false,
  seasonCategory: 'unscheduled'
}

const schedule: ScheduleEntry[] = [
  {
    gameId: 'gam_final',
    startsAt: '2027-04-03T17:00:00.000Z',
    homeTeam: { id: 'tem_hawks', name: 'Hawks' },
    awayTeam: { id: 'tem_owls', name: 'Owls' },
    venue: 'Northpoint Field 1'
  },
  {
    gameId: 'gam_next',
    startsAt: '2027-04-17T17:00:00.000Z',
    homeTeam: { id: 'tem_owls', name: 'Owls' },
    awayTeam: { id: 'tem_hawks', name: 'Hawks' },
    venue: null
  }
]

const staff: StaffEntry[] = [
  {
    userId: userIdOfGumbo(11),
    shortName: 'Harper H',
    avatarUrl: null,
    roles: ['admin']
  },
  {
    userId: userIdOfGumbo(12),
    shortName: 'Hank C',
    avatarUrl: null,
    roles: ['coach', 'scorekeeper']
  }
]

const roster = [
  asRosterEntry({
    userId: userIdOfGumbo(11),
    shortName: 'Harper H',
    jersey: null,
    positions: [],
    isPlayer: false,
    role: 'owner',
    group: 'coach',
    section: 'admin',
    staffRoles: [],
    inheritedFrom: null
  }),
  asRosterEntry({
    userId: userIdOfGumbo(21),
    shortName: 'Pat P',
    jersey: '7',
    positions: ['SS'],
    isPlayer: true,
    role: 'member',
    group: 'player',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null
  })
]

interface Calls {
  asked: string[]
  follows: string[]
  unfollows: string[]
}

function fakeClient(patch: Record<string, unknown> = {}): {
  client: TeamStationClient
  calls: Calls
} {
  const calls: Calls = { asked: [], follows: [], unfollows: [] }
  const asked =
    <T,>(name: string, answer: T) =>
    async (): Promise<T> => {
      calls.asked.push(name)
      return answer
    }
  const client = {
    teamSchedule: asked('teamSchedule', schedule),
    teamStaff: asked('teamStaff', staff),
    roster: asked('roster', roster),
    teamGames: asked('teamGames', [
      asGameSummary({
        id: 'gam_final',
        homeTeamId: 'tem_hawks',
        awayTeamId: 'tem_owls',
        homeTeamName: 'Hawks',
        awayTeamName: 'Owls',
        seasonId: 'sea_1',
        startAt: '2027-04-03T17:00:00.000Z',
        venue: null,
        status: 'final',
        homeScore: 6,
        awayScore: 3,
        ingestStatus: 'ok',
        videoCount: 1
      })
    ]),
    teamStats: asked('teamStats', []),
    standings: asked('standings', []),
    follow: async (teamId: string) => {
      calls.follows.push(teamId)
      return true
    },
    unfollow: async (teamId: string) => {
      calls.unfollows.push(teamId)
      return false
    },
    ...patch
  } as unknown as TeamStationClient
  return { client, calls }
}

describe('TeamScreen for a fan', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('shows only the Schedule and Team tabs, and asks for nothing else', async function () {
    const { client, calls } = fakeClient()
    const opened: string[] = []
    const tabsSaid: Array<[string, boolean | undefined]> = []
    await render(
      <TeamScreen
        client={client}
        team={{ ...hawks, access: 'fan', following: true, onTeam: false }}
        initialTab="videos"
        onTab={(tab, correcting) => {
          tabsSaid.push([tab, correcting])
        }}
        onOpenGame={gameId => {
          opened.push(gameId)
        }}
        onOpenPlayer={() => {
          opened.push('player')
        }}
      />
    )
    expect(tabs()).deep.equals(['Schedule', 'Team'])
    // An address that asked for Videos is answered with the schedule.
    expect(tabsSaid).deep.equals([['schedule', true]])
    expect([...calls.asked].sort()).deep.equals([
      'roster',
      'teamSchedule',
      'teamStaff'
    ])

    // The schedule: dates and opponents, and cards that open nothing.
    expect(text()).contains('2 games')
    expect(text()).contains('vs Owls')
    expect(text()).contains('@ Owls')
    expect(text()).contains('Northpoint Field 1')
    expect(control('Hawks vs Owls')).equals(undefined)
    expect(control('Hawks @ Owls')).equals(undefined)

    // The team: the staff with their roles, then the players.
    await press('Team')
    expect(text()).contains('Harper H')
    expect(text()).contains('Admin')
    expect(text()).contains('Coach · Scorekeeper')
    expect(text()).contains('Pat P')
    expect(text()).contains('#7')
    // Nobody's name opens a player page the fan cannot read.
    expect(control('Pat P')).equals(undefined)
    expect(opened).deep.equals([])
    expect([...calls.asked].sort()).deep.equals([
      'roster',
      'teamSchedule',
      'teamStaff'
    ])
  })

  it('opens on the Team tab when the address says roster', async function () {
    const { client } = fakeClient({
      teamSchedule: async () => [],
      roster: async () => [],
      teamStaff: async () => []
    })
    await render(
      <TeamScreen
        client={client}
        team={{ ...hawks, access: 'fan', following: true, onTeam: false }}
        initialTab="roster"
        onOpenGame={() => undefined}
      />
    )
    expect(text()).contains('No players have been added to this team yet.')
    await press('Schedule')
    expect(text()).contains('No games scheduled.')
  })

  it('links to the team’s chats the person is in', async function () {
    const { client } = fakeClient()
    const opened: string[] = []
    await render(
      <TeamScreen
        client={client}
        team={{ ...hawks, access: 'fan', following: true, onTeam: false }}
        onOpenGame={() => undefined}
        chats={[{ id: 'cnv_fans', title: 'Hawks Fans' }]}
        onOpenChat={chat => opened.push(chat.id)}
      />
    )
    await press('Open Hawks Fans')
    expect(opened).deep.equals(['cnv_fans'])
  })

  it('turns Following back into Follow, and says why when it cannot', async function () {
    const { client, calls } = fakeClient()
    await render(
      <TeamScreen
        client={client}
        team={{ ...hawks, access: 'fan', following: true, onTeam: false }}
        onOpenGame={() => undefined}
      />
    )
    await press('Following Hawks')
    expect(calls.unfollows).deep.equals(['tem_hawks'])
    expect(control('Follow Hawks')).not.equals(undefined)
    await press('Follow Hawks')
    expect(calls.follows).deep.equals(['tem_hawks'])
    expect(control('Following Hawks')).not.equals(undefined)
  })

  it('shows a failed follow and keeps the button as it was', async function () {
    const { client } = fakeClient({
      follow: async () => {
        throw new HttpError('notFound', 'Not found')
      }
    })
    await render(
      <TeamScreen
        client={client}
        team={{ ...hawks, access: 'member', following: false, onTeam: false }}
        onOpenGame={() => undefined}
      />
    )
    await press('Follow Hawks')
    expect(text()).contains('Not found')
    expect(control('Follow Hawks')).not.equals(undefined)
  })
})

describe('TeamScreen for the team’s own people', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('offers no Follow to somebody on the team, or when nobody said', async function () {
    for (const team of [
      { ...hawks, access: 'member' as const, onTeam: true },
      hawks
    ]) {
      const { client, calls } = fakeClient()
      await render(
        <TeamScreen client={client} team={team} onOpenGame={() => undefined} />
      )
      expect(tabs()).deep.equals(['Videos', 'Schedule', 'Team', 'Stats'])
      expect(control('Follow Hawks')).equals(undefined)
      expect(control('Following Hawks')).equals(undefined)
      expect(calls.asked).to.include('teamGames')
      expect(calls.asked).not.to.include('teamSchedule')
      await act(async () => {
        root?.unmount()
      })
    }
  })
})

describe('staffSubtitle', function () {
  it('names every role, administrator first as the server sends them', function () {
    expect(staffSubtitle(staff[1])).equals('Coach · Scorekeeper')
    expect(
      staffSubtitle({
        userId: userIdOfGumbo(1),
        shortName: 'V',
        avatarUrl: null,
        roles: ['songkeeper', 'videographer']
      })
    ).equals('Songkeeper · Videographer')
  })
})
