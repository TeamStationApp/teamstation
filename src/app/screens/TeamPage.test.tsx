import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asGameSummary,
  asRosterEntry,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { asGroupDetail, type GroupDetail } from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import { ManagementCard } from './ManagementCard'
import { TeamPage } from './TeamPage'

let root: Root | undefined
const detail = (patch: Partial<GroupDetail> = {}): GroupDetail =>
  asGroupDetail({
    group: {
      kind: 'team',
      id: 'canonical',
      name: 'Demo Hawks',
      imageUrl: null,
      locality: null
    },
    parents: [],
    children: [],
    participatingSeasons: [],
    competingTeams: [],
    games: [],
    staff: [],
    canViewPrivate: false,
    nonMemberView: false,
    canManage: false,
    ...patch
  })
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
async function mount(el: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{el}</ThemeProvider>)
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}
async function press(label: string): Promise<void> {
  const n = [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ].find(n => (n.getAttribute('aria-label') ?? n.textContent) === label)
  expect(n, label).not.equals(undefined)
  await act(async () => {
    n!.click()
  })
}
describe('restored access-aware team presentation', () => {
  for (const allowed of [true, false])
    it(`offers canonical-team event creation only when scheduling is ${allowed ? 'allowed' : 'refused'}`, async () => {
      const api = new TeamStationClient({ baseUrl: '/api/v1' })
      api.group = async () =>
        detail({ canViewPrivate: true, canManagePeople: allowed })
      api.teamGames = async () => []
      api.roster = async () => []
      api.teamStats = async () => []
      api.teamPitchingStats = async () => []
      api.standings = async () => []
      api.follows = async () => []
      let created = ''
      await mount(
        <TeamPage
          client={api}
          id="alias"
          initialTab="schedule"
          onOpenGame={() => undefined}
          onCreateGame={id => {
            created = id
          }}
        />
      )
      expect(
        document.querySelector('[data-testid="add-game-button"]') != null
      ).equals(allowed)
      if (allowed) {
        await press('Add Game')
        expect(created).equals('canonical')
      }
    })
  for (const refused of [false, true])
    it(`revalidates the mounted private schedule on foreground ${refused ? 'and clears refused collections' : 'without resetting its section'}`, async () => {
      const api = new TeamStationClient({ baseUrl: '/api/v1' })
      let groups = 0
      let games = 0
      let refreshed = false
      api.group = async () => {
        groups++
        return detail({ canViewPrivate: true })
      }
      api.teamGames = async () => {
        games++
        if (refreshed && refused)
          throw new HttpError('forbidden', 'Team membership removed')
        return [
          asGameSummary({
            id: 'demo-refresh-game',
            homeTeamId: 'canonical',
            awayTeamId: 'visitor',
            homeTeamName: 'Demo Hawks',
            awayTeamName: 'Demo Visitors',
            seasonId: null,
            startAt: '2099-01-01T18:00:00Z',
            venue: null,
            status: refreshed ? 'cancelled' : 'scheduled',
            homeScore: null,
            awayScore: null,
            videoCount: 0,
            ingestStatus: 'none',
            pendingApproval: !refreshed,
            pendingRequestId: refreshed ? null : 'demo-pending'
          })
        ]
      }
      api.roster = async () => []
      api.teamStats = async () => []
      api.teamPitchingStats = async () => []
      await mount(
        <TeamPage
          client={api}
          id="canonical"
          initialTab="schedule"
          onOpenGame={() => undefined}
        />
      )
      expect(document.body.textContent).includes('Pending approval')
      refreshed = true
      await act(async () => {
        window.dispatchEvent(new window.Event('focus'))
        await new Promise(resolve => setTimeout(resolve, 20))
      })
      expect(groups).equals(2)
      expect(games).equals(2)
      expect(document.body.textContent).not.includes('Pending approval')
      expect(document.body.textContent).includes(
        refused ? 'Team membership removed' : 'Canceled'
      )
      expect(
        document.querySelector(
          '[aria-label="Team sections"] [aria-selected="true"]'
        )?.textContent
      ).equals('Schedule')
      if (refused)
        expect(document.body.textContent).not.includes('Demo Visitors')
    })
  for (const fails of [false, true])
    it(`hides the previous team's controls during a delayed identity ${fails ? 'failure' : 'change'}`, async () => {
      const api = new TeamStationClient({ baseUrl: '/api/v1' })
      let resolveNext!: (found: GroupDetail) => void
      let rejectNext!: (error: Error) => void
      api.group = async ({ id }) =>
        id === 'a'
          ? detail({ canViewPrivate: true, canManage: true })
          : await new Promise<GroupDetail>((resolve, reject) => {
              resolveNext = resolve
              rejectNext = reject
            })
      let reads = 0
      api.teamGames = async () => {
        reads++
        return []
      }
      api.roster = async () => []
      api.teamStats = async () => []
      api.teamPitchingStats = async () => []
      api.invites = async () => ({ canInvite: true, invites: [] })
      let settings = ''
      const view = (id: string): React.ReactElement => (
        <TeamPage
          client={api}
          id={id}
          onOpenGame={() => undefined}
          onSettings={id => {
            settings = id
          }}
        />
      )
      await mount(view('a'))
      await press('Manage')
      expect(settings).equals('canonical')
      await act(async () => {
        root!.render(<ThemeProvider>{view('b')}</ThemeProvider>)
      })
      expect(document.body.textContent).includes('Loading…')
      expect(document.body.textContent).not.includes('Demo Hawks')
      expect(document.querySelector('[aria-label="Manage"]')).equals(null)
      expect(document.querySelector('[aria-label="Team sections"]')).equals(
        null
      )
      await act(async () => {
        if (fails) rejectNext(new Error('New team unavailable'))
        else
          resolveNext(
            detail({ group: { ...detail().group, id: 'b', name: 'Demo Owls' } })
          )
      })
      expect(document.body.textContent).includes(
        fails ? 'New team unavailable' : 'Demo Owls'
      )
      expect(document.body.textContent).not.includes('Demo Hawks')
      expect(reads).equals(1)
    })
  it('uses the original four-tab shell without private requests for somebody signed out', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => detail()
    let privateReads = 0
    for (const method of [
      'teamGames',
      'roster',
      'teamStats',
      'teamPitchingStats',
      'standings',
      'invites'
    ] as const)
      api[method] = async () => {
        privateReads++
        throw new Error('Private collection requested')
      }
    await mount(
      <TeamPage client={api} id="alias" onOpenGame={() => undefined} />
    )
    expect(
      [...document.querySelectorAll('[role="tab"]')].map(n => n.textContent)
    ).deep.equals(['Videos', 'Schedule', 'Team', 'Stats'])
    expect(document.body.textContent).includes(
      'No game has a video attached yet.'
    )
    await press('Schedule')
    expect(document.body.textContent).includes('No games scheduled.')
    await press('Team')
    expect(document.body.textContent).includes('Standalone team')
    await press('Stats')
    expect(document.body.textContent).includes(
      'You need to be a member of this team to see individual player stats.'
    )
    expect(document.body.textContent).not.includes('Create Game')
    expect(privateReads).equals(0)
  })
  for (const following of [true, false])
    it(`gives anybody signed in who is not a member the full team page${following ? ', following it' : ', not following it, as from Search'}, asking for nothing kept for members`, async () => {
      const api = new TeamStationClient({ baseUrl: '/api/v1' })
      api.group = async () => detail({ nonMemberView: true })
      const asked: string[] = []
      api.teamGames = async id => {
        asked.push(`teamGames ${id}`)
        return []
      }
      api.roster = async id => {
        asked.push(`roster ${id}`)
        return [
          asRosterEntry({
            userId: userIdOfGumbo(201),
            gumboId: 201,
            shortName: 'Alfonso S',
            jersey: '7',
            positions: ['SS'],
            isPlayer: true,
            role: 'member',
            section: 'player',
            staffRoles: [],
            inheritedFrom: null
          })
        ]
      }
      for (const method of [
        'teamStats',
        'teamPitchingStats',
        'invites'
      ] as const)
        api[method] = async () => {
          asked.push(method)
          throw new Error('Kept for members')
        }
      api.follows = async () => (following ? [detail().group] : [])
      await mount(
        <TeamPage
          client={api}
          id="alias"
          initialTab="team"
          onOpenGame={() => undefined}
          onOpenPlayer={() => undefined}
        />
      )
      expect(
        [...document.querySelectorAll('[role="tab"]')].map(n => n.textContent)
      ).deep.equals(['Videos', 'Schedule', 'Team', 'Stats'])
      // The members' roster, not the public page's staff list.
      expect(document.body.textContent).includes('Alfonso S')
      expect(document.body.textContent).not.includes('Standalone team')
      expect(document.body.textContent).not.includes(
        'No game has a video attached yet.'
      )
      expect(document.querySelector('[aria-label^="Alfonso S"]')).equals(null)
      await press('Stats')
      expect(document.body.textContent).includes('SEASON PERFORMANCE')
      expect(document.body.textContent).includes(
        'You need to be a member of this team to see individual player stats.'
      )
      expect(asked).deep.equals(['teamGames canonical', 'roster canonical'])
      // Following it or not changes the button on the card, and nothing else.
      expect(
        document.querySelector(
          `[aria-label="${following ? 'Unfollow' : 'Follow'} Demo Hawks"]`
        )
      ).not.equals(null)
    })
  it('loads private collections with the canonical identity and sends the gear to settings', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => detail({ canViewPrivate: true, canManage: true })
    const ids: string[] = []
    api.teamGames = async id => {
      ids.push(id)
      return []
    }
    api.roster = async () => []
    api.teamStats = async () => []
    api.teamPitchingStats = async () => []
    api.invites = async () => ({ canInvite: true, invites: [] })
    let settings = ''
    await mount(
      <TeamPage
        client={api}
        id="old-alias"
        onOpenGame={() => undefined}
        onSettings={id => {
          settings = id
        }}
      />
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(ids).deep.equals(['canonical'])
    expect(document.body.textContent).includes('GAME VIDEO LIBRARY')
    await press('Manage')
    expect(settings).equals('canonical')
  })
  it('shows retry after failure, ignores stale responses and clears private access on refresh', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    let fail = true
    api.group = async () => {
      if (fail) throw new Error('Team unavailable')
      return detail()
    }
    await mount(
      <TeamPage
        client={api}
        id="demo"
        onOpenGame={() => undefined}
        initialTab="invalid"
      />
    )
    expect(document.body.textContent).includes('Team unavailable')
    fail = false
    await press('Retry team')
    expect(document.body.textContent).includes('Demo Hawks')
  })
  it('discards an older access answer and clears a private page after revocation', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    let first!: (value: GroupDetail) => void
    let calls = 0
    api.group = async () =>
      ++calls === 1
        ? await new Promise<GroupDetail>(resolve => {
            first = resolve
          })
        : detail({ canViewPrivate: calls === 2 })
    let privateReads = 0
    api.teamGames = async () => {
      privateReads++
      return []
    }
    api.roster = async () => []
    api.teamStats = async () => []
    api.teamPitchingStats = async () => []
    await mount(
      <TeamPage client={api} id="demo" onOpenGame={() => undefined} />
    )
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(privateReads).equals(1)
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(document.body.textContent).includes(
      'No game has a video attached yet.'
    )
    await act(async () => {
      first(detail({ canViewPrivate: true }))
    })
    expect(document.body.textContent).includes(
      'No game has a video attached yet.'
    )
    expect(privateReads).equals(1)
  })
  it('follows changed tab addresses while preserving the mounted private team', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => detail({ canViewPrivate: true })
    let reads = 0
    api.teamGames = async () => {
      reads++
      return []
    }
    api.roster = async () => []
    api.teamStats = async () => []
    api.teamPitchingStats = async () => []
    await mount(
      <TeamPage
        client={api}
        id="demo"
        initialTab="videos"
        onOpenGame={() => undefined}
      />
    )
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <TeamPage
            client={api}
            id="demo"
            initialTab="stats"
            onOpenGame={() => undefined}
          />
        </ThemeProvider>
      )
    })
    expect(document.body.textContent).includes('SEASON PERFORMANCE')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <TeamPage
            client={api}
            id="demo"
            initialTab="roster"
            onOpenGame={() => undefined}
          />
        </ThemeProvider>
      )
    })
    expect(document.body.textContent).includes('Nobody has been added')
    expect(reads).equals(1)
  })
  it('keeps custodial settings available without granting private collections', async () => {
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.group = async () => detail({ canManage: true })
    let settings = ''
    await mount(
      <TeamPage
        client={api}
        id="demo"
        onOpenGame={() => undefined}
        onSettings={id => {
          settings = id
        }}
      />
    )
    await press('Team settings')
    expect(settings).equals('canonical')
    expect(document.body.textContent).includes(
      'No game has a video attached yet.'
    )
  })
})
describe('gear-only team actions', () => {
  it('forwards canonical team contexts for every full-team management action', async () => {
    const seen: unknown[] = []
    await mount(
      <ManagementCard
        detail={detail({ canManage: true })}
        onAddPeople={v => seen.push(v)}
        onInvites={v => seen.push(v)}
        onPromote={v => seen.push(v)}
      />
    )
    for (const label of ['Add Person to Team', 'Create Invite Link'])
      await press(label)
    // People are added from Settings and managed from the roster now.
    expect(document.body.textContent).not.includes('Manage people')
    expect(seen).deep.equals([
      ...Array(2).fill({ kind: 'team', id: 'canonical' })
    ])
  })
  it('offers placeholder promotion with custody and hides unavailable/unauthorized actions', async () => {
    let promoted = ''
    const ph = detail({
      canManage: true,
      group: { ...detail().group, external: true },
      custodian: {
        ...detail().group,
        id: 'custody',
        name: 'Demo League',
        kind: 'league'
      }
    })
    await mount(
      <ManagementCard
        detail={ph}
        onPromote={v => {
          promoted = v.id
        }}
      />
    )
    expect(document.body.textContent).includes('Managed by Demo League')
    await press('Invite team administrator')
    expect(promoted).equals('canonical')
    expect(document.body.textContent).not.includes('Join a Season')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ManagementCard detail={detail()} />
        </ThemeProvider>
      )
    })
    expect(document.body.textContent).equals('')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ManagementCard
            detail={detail({
              group: { ...detail().group, kind: 'league' },
              canManage: true
            })}
          />
        </ThemeProvider>
      )
    })
    expect(document.body.textContent).includes('LEAGUE MANAGEMENT')
  })
})
