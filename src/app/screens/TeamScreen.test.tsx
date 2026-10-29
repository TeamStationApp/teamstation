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
import type { GameListOpenOptions } from './gameListOptions'
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
    userId: userIdOfGumbo(12),
    shortName: 'Hank C',
    jersey: null,
    positions: [],
    isPlayer: false,
    role: 'member',
    section: 'staff',
    staffRoles: ['coach', 'scorekeeper'],
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
  follows: Array<{ kind: string; id: string }>
  unfollows: Array<{ kind: string; id: string }>
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
        venue: 'Northpoint Field 1',
        status: 'final',
        homeScore: 6,
        awayScore: 3,
        ingestStatus: 'ok',
        videoCount: 1
      }),
      asGameSummary({
        id: 'gam_next',
        homeTeamId: 'tem_owls',
        awayTeamId: 'tem_hawks',
        homeTeamName: 'Owls',
        awayTeamName: 'Hawks',
        seasonId: 'sea_1',
        startAt: '2027-04-17T17:00:00.000Z',
        venue: null,
        status: 'scheduled',
        homeScore: null,
        awayScore: null,
        ingestStatus: 'ok',
        videoCount: 0
      })
    ]),
    teamStats: asked('teamStats', []),
    teamPitchingStats: asked('teamPitchingStats', []),
    standings: asked('standings', []),
    follows: asked('follows', [{ kind: 'team', id: hawks.id }]),
    follow: async (group: { kind: string; id: string }) => {
      calls.follows.push(group)
      return true
    },
    unfollow: async (group: { kind: string; id: string }) => {
      calls.unfollows.push(group)
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

  it('opens public games without playback and keeps player pages and figures private', async function () {
    const { client, calls } = fakeClient()
    const opened: string[] = []
    const tabsSaid: Array<[string, boolean | undefined]> = []
    const options: Array<GameListOpenOptions | undefined> = []
    await render(
      <TeamScreen
        client={client}
        nonMemberView
        team={{ ...hawks, access: 'fan', following: true, onTeam: false }}
        initialTab="videos"
        onTab={(tab, correcting) => {
          tabsSaid.push([tab, correcting])
        }}
        onOpenGame={(gameId, _title, request) => {
          opened.push(gameId)
          options.push(request)
        }}
        onOpenPlayer={() => {
          opened.push('player')
        }}
      />
    )
    expect(tabs()).deep.equals(['Videos', 'Schedule', 'Team', 'Stats', 'Chats'])
    expect(tabsSaid).deep.equals([])
    expect([...calls.asked].sort()).deep.equals([
      'follows',
      'roster',
      'standings',
      'teamGames'
    ])

    await press('Hawks vs Owls')
    expect(opened).deep.equals(['gam_final'])
    expect(options).deep.equals([{ tab: 'watch', autoPlay: false }])
    await press('Schedule')
    // Published games open without private RSVP controls or playback.
    expect(text()).contains('2 games')
    expect(text()).contains('vs Owls')
    expect(text()).contains('@ Owls')
    expect(text()).contains('Northpoint Field 1')
    await press('vs Owls')
    expect(opened).deep.equals(['gam_final', 'gam_final'])
    expect(options[1]).deep.equals({ autoPlay: false })
    expect(control('RSVP')).equals(undefined)

    // The team: the staff with their roles, then the players.
    await press('Team')
    expect(text()).contains('Harper H')
    expect(text()).contains('ADMINS')
    expect(text()).contains('Coach · Scorekeeper')
    expect(text()).contains('Pat P')
    expect(text()).contains('#7')
    // Nobody's name opens a player page the fan cannot read.
    expect(control('Pat P')).equals(undefined)
    expect(opened).deep.equals(['gam_final', 'gam_final'])
    await press('Stats')
    expect(text()).contains(
      'You need to be a member of this team to see individual player stats.'
    )
    expect(text()).not.contains('BATTING')
    expect(text()).not.contains('PITCHING')
    expect([...calls.asked].sort()).deep.equals([
      'follows',
      'roster',
      'standings',
      'teamGames'
    ])
  })

  it('opens on the Team tab when the address says roster', async function () {
    const { client } = fakeClient({
      teamSchedule: async () => [],
      teamGames: async () => [],
      roster: async () => [],
      teamStaff: async () => []
    })
    await render(
      <TeamScreen
        client={client}
        nonMemberView
        team={{ ...hawks, access: 'fan', following: true, onTeam: false }}
        initialTab="roster"
        onOpenGame={() => undefined}
      />
    )
    expect(text()).contains('Nobody has been added to this team yet.')
    await press('Schedule')
    expect(text()).contains('No games scheduled.')
  })

  it('links to the team’s chats the person is in', async function () {
    const { client } = fakeClient()
    const opened: string[] = []
    await render(
      <TeamScreen
        client={client}
        nonMemberView
        team={{ ...hawks, access: 'fan', following: true, onTeam: false }}
        onOpenGame={() => undefined}
        chats={[{ id: 'cnv_fans', title: 'Hawks Fans', label: 'Fans' }]}
        onOpenChat={chat => opened.push(chat.id)}
      />
    )
    expect(control('Open Fans')).equals(undefined)
    await press('Chats')
    await press('Open Fans')
    expect(opened).deep.equals(['cnv_fans'])
  })

  it('turns Following back into Follow and follows the same group again', async function () {
    const { client, calls } = fakeClient()
    await render(
      <TeamScreen
        client={client}
        nonMemberView
        team={{ ...hawks, access: 'fan', following: true, onTeam: false }}
        onOpenGame={() => undefined}
      />
    )
    await press('Unfollow Hawks')
    expect(calls.unfollows).deep.equals([{ kind: 'team', id: 'tem_hawks' }])
    expect(control('Follow Hawks')).not.equals(undefined)
    await press('Follow Hawks')
    expect(calls.follows).deep.equals([{ kind: 'team', id: 'tem_hawks' }])
    expect(control('Unfollow Hawks')).not.equals(undefined)
  })

  it('keeps a failed follow available without falsely showing Following', async function () {
    const { client } = fakeClient({
      follows: async () => [],
      follow: async () => {
        throw new HttpError('notFound', 'Not found')
      }
    })
    await render(
      <TeamScreen
        client={client}
        nonMemberView
        team={{ ...hawks, access: 'member', following: false, onTeam: false }}
        onOpenGame={() => undefined}
      />
    )
    await press('Follow Hawks')
    expect(control('Follow Hawks')).not.equals(undefined)
    expect(control('Unfollow Hawks')).equals(undefined)
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
      expect(tabs()).deep.equals(['Videos', 'Schedule', 'Team', 'Stats', 'Chats'])
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
