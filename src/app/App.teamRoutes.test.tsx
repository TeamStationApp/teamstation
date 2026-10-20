import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import {
  asPersonProfile,
  asRosterEntry,
  asSessionUser,
  TeamStationClient
} from '../common/api'
import { asGroupDetail } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { App, stackFor } from './App'

describe('team route frames', () => {
  it('reconstructs Settings under every directly opened management child', () => {
    for (const name of [
      'groupLocation',
      'groupAddPeople',
      'groupInvites'
    ] as const) {
      for (const kind of ['team', 'league'] as const) {
        const teamReturn =
          kind === 'team'
            ? { id: 'alias', address: 'team' as const, tab: 'schedule' }
            : undefined
        const route = { name, kind, id: 'canonical', teamReturn }
        const stack = stackFor(route).home!
        expect(stack.at(-1)).deep.equals(route)
        expect(stack.at(-2)).deep.equals({
          name: 'groupSettings',
          kind,
          id: 'canonical',
          teamReturn
        })
        if (kind === 'team')
          expect(stack[0]).deep.equals(
            stackFor({ name: 'team', teamId: 'alias', tab: 'schedule' })
              .home![0]
          )
      }
    }
  })
  it('retains the team or group return frame through settings address reconstruction', () => {
    for (const address of ['team', 'group'] as const) {
      const route = {
        name: 'groupSettings' as const,
        kind: 'team' as const,
        id: 'canonical',
        teamReturn: { id: 'alias', address, tab: 'schedule' }
      }
      const stack = stackFor(route).home!
      expect(stack[0]).deep.equals(
        stackFor(
          address === 'team'
            ? { name: 'team', teamId: 'alias', tab: 'schedule' }
            : { name: 'group', kind: 'team', id: 'alias', tab: 'schedule' }
        ).home![0]
      )
      expect(stack[1]).deep.equals(route)
    }
  })
  it('opens a team address before requesting private lists, retaining its tab', () => {
    const top = stackFor({ name: 'team', teamId: 'demo_alias', tab: 'roster' })
      .home?.[0]
    expect(top?.name).equals('team')
    if (top?.name !== 'team') throw new Error('Expected team frame')
    expect(top.team).includes({
      id: 'demo_alias',
      name: '',
      canViewPrivate: false
    })
    expect(top.tab).equals('roster')
  })
  it('puts the public/private team adapter underneath a direct settings address', () => {
    expect(
      stackFor({ name: 'groupSettings', kind: 'team', id: 'demo_team' }).home
    ).deep.equals([
      { name: 'group', kind: 'team', id: 'demo_team' },
      { name: 'groupSettings', kind: 'team', id: 'demo_team' }
    ])
  })
  it('retains ordinary group and game settings frame behavior', () => {
    expect(
      stackFor({ name: 'group', kind: 'league', id: 'demo_league' }).home
    ).deep.equals([{ name: 'group', kind: 'league', id: 'demo_league' }])
    expect(
      stackFor({ name: 'gameSettings', gameId: 'demo_game' }).home?.map(
        frame => frame.name
      )
    ).deep.equals(['game', 'gameSettings'])
  })
})

describe('team settings browser history', () => {
  // Two visits of a dozen 60 ms settles each run past mocha's two seconds,
  // and a test that times out keeps acting under the ones after it.
  it('returns to the original section after Back and Forward while individual saves stay in settings', async () => {
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    const detail = asGroupDetail({
      nonMemberView: false,
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
      canManage: true
    })
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo Admin',
        isAdmin: false
      })
    proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
    proto.hasNotifications = async () => false
    proto.group = async () => detail
    proto.gameProposals = async () => []
    proto.updateGroup = async () => detail.group
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60))
      })
    }
    const press = async (label: string): Promise<void> => {
      const button = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="button"], [role="tab"]'
        )
      ].find(
        node => (node.getAttribute('aria-label') ?? node.textContent) === label
      )
      expect(button, label).not.equals(undefined)
      await act(async () => {
        button!.click()
      })
      await settle()
    }
    try {
      for (const [path, tab] of [
        ['/teams/alias?tab=schedule', 'Schedule'],
        ['/groups/team/alias?tab=stats', 'Stats']
      ]) {
        window.history.replaceState(null, '', path)
        const host = document.createElement('div')
        document.body.append(host)
        const root = createRoot(host)
        try {
          await act(async () => {
            root.render(<App />)
          })
          await settle()
          await press('Team settings')
          await act(async () => {
            window.history.back()
            await new Promise(resolve => setTimeout(resolve, 60))
          })
          await settle()
          expect(window.location.pathname + window.location.search).equals(path)
          await act(async () => {
            window.history.forward()
            await new Promise(resolve => setTimeout(resolve, 60))
          })
          await settle()
          expect(window.location.pathname).equals(
            '/groups/team/canonical/settings'
          )
          const input = document.querySelector<HTMLInputElement>(
            '[aria-label="Name"]'
          )!
          await act(async () => {
            Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              'value'
            )!.set!.call(input, 'Wrens')
            input.dispatchEvent(new window.Event('input', { bubbles: true }))
          })
          await press('Save name')
          expect(window.location.pathname).equals(
            '/groups/team/canonical/settings'
          )
          await press('Back')
          expect(window.location.pathname + window.location.search).equals(path)
          expect(
            document.querySelector(
              '[aria-label="Team sections"] [aria-selected="true"]'
            )?.textContent
          ).equals(tab)
        } finally {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        }
      }
    } finally {
      Object.defineProperties(proto, originals)
      window.history.replaceState(null, '', '/')
    }
  }).timeout(15000)
})

describe('a person’s profile, through the app', () => {
  it('opens from the roster for the team’s coach at its own address, titled with their name, and the old manage address opens Settings', async () => {
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    const detail = asGroupDetail({
      nonMemberView: false,
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
      canViewPrivate: true,
      canManage: false,
      canManagePeople: true
    })
    const asked: unknown[] = []
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo Coach',
        isAdmin: false
      })
    proto.myRoles = async () => ({
      teams: { canonical: ['coach'] },
      guardianOf: []
    })
    proto.hasNotifications = async () => false
    proto.group = async () => detail
    proto.gameProposals = async () => []
    proto.teamGames = async () => []
    proto.teamStats = async () => []
    proto.teamPitchingStats = async () => []
    proto.roster = async () => [
      asRosterEntry({
        userId: userIdOfGumbo(203),
        gumboId: 203,
        shortName: 'Pat Y',
        jersey: null,
        positions: [],
        isPlayer: false,
        role: 'member',
        section: 'family',
        staffRoles: [],
        inheritedFrom: null
      })
    ]
    proto.personProfile = async (kind, id, userId) => {
      asked.push([kind, id, userId])
      return asPersonProfile({
        context: { kind: 'team', id: 'canonical', name: 'Demo Hawks' },
        person: {
          userId: userIdOfGumbo(203),
          gumboId: 203,
          shortName: 'Pat Y',
          fullName: 'Pat Young',
          avatarUrl: null,
          canHoldRoles: true
        },
        guardianOf: [],
        sections: [],
        viewer: { manages: true, admin: false }
      })
    }
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60))
      })
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      window.history.replaceState(null, '', '/teams/alias?tab=team')
      await act(async () => {
        root.render(<App />)
      })
      await settle()
      const row = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ].find(node => node.textContent?.includes('Pat Y') === true)
      expect(row).not.equals(undefined)
      await act(async () => {
        row!.click()
      })
      await settle()
      expect(asked).deep.equals([['team', 'canonical', userIdOfGumbo(203)]])
      expect(window.location.pathname).equals(
        '/teams/canonical/people/usr_111111111111111111114W'
      )
      expect(document.body.textContent).includes('Pat Young')
      expect(document.body.textContent).includes('Team · Demo Hawks')
      await act(async () => {
        root.unmount()
      })

      const again = createRoot(host)
      window.history.replaceState(null, '', '/teams/canonical/manage')
      await act(async () => {
        again.render(<App />)
      })
      await settle()
      expect(window.location.pathname).equals('/groups/team/canonical/settings')
      await act(async () => {
        again.unmount()
      })
    } finally {
      host.remove()
      Object.defineProperties(proto, originals)
      window.history.replaceState(null, '', '/')
    }
  })
})

describe('roles given by somebody else, through the app', () => {
  it('reads the signed-in person’s roles again when the inbox opens', async () => {
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    let reads = 0
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo Member',
        isAdmin: false
      })
    proto.myRoles = async () => {
      reads++
      return { teams: {}, guardianOf: [] }
    }
    proto.hasNotifications = async () => true
    proto.notifications = async () => ({
      items: [],
      hasPending: false,
      nextCursor: null
    })
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60))
      })
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      window.history.replaceState(null, '', '/')
      await act(async () => {
        root.render(<App />)
      })
      await settle()
      const before = reads
      expect(before).greaterThan(0)
      const bell = document.querySelector<HTMLElement>(
        '[aria-label="Notifications"]'
      )
      expect(bell).not.equals(null)
      await act(async () => {
        bell!.click()
      })
      await settle()
      expect(window.location.pathname).equals('/notifications')
      expect(reads).equals(before + 1)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      Object.defineProperties(proto, originals)
      window.history.replaceState(null, '', '/')
    }
  })
})

describe('a season’s and a league’s People tab, however the page is opened', () => {
  const people = [
    asRosterEntry({
      userId: userIdOfGumbo(203),
      gumboId: 203,
      shortName: 'Pat Y',
      jersey: null,
      positions: [],
      isPlayer: false,
      role: 'member',
      section: 'spectator',
      staffRoles: [],
      inheritedFrom: null
    })
  ]
  const detailOf = (
    kind: 'season' | 'league',
    canSeePeople: boolean
  ): ReturnType<typeof asGroupDetail> =>
    asGroupDetail({
      nonMemberView: false,
      group: {
        kind,
        id: kind === 'season' ? 'sea_spring' : 'lea_demo',
        name: kind === 'season' ? 'Demo Regular' : 'Demo League',
        imageUrl: null,
        locality: null
      },
      parents: [],
      children: [],
      participatingSeasons: [],
      competingTeams: [],
      games: [],
      staff: [],
      canViewPrivate: true,
      canManage: false,
      canManagePeople: false,
      canSeePeople
    })

  /** Opens `path` in the app as a signed-in member, and answers the tabs. */
  async function open(
    path: string,
    canSeePeople: boolean
  ): Promise<{ tabs: string[]; asked: unknown[]; done: () => Promise<void> }> {
    const proto = TeamStationClient.prototype
    const originals = Object.getOwnPropertyDescriptors(proto)
    const asked: unknown[] = []
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo Member',
        isAdmin: false
      })
    proto.myRoles = async () => ({ teams: {}, guardianOf: [] })
    proto.hasNotifications = async () => false
    proto.seasons = async () => [
      {
        id: 'sea_spring',
        leagueId: null,
        name: 'Demo Regular',
        year: 2026,
        term: null,
        ageGroup: null,
        teams: 0,
        games: 0,
        videos: 0,
        logoUrl: null
      }
    ]
    proto.group = async ref => {
      asked.push(['group', ref.kind, ref.id])
      return detailOf(ref.kind === 'league' ? 'league' : 'season', canSeePeople)
    }
    proto.seasonGames = async () => []
    proto.seasonTeams = async () => []
    proto.standings = async () => []
    proto.seasonStats = async seasonId => ({
      seasonId,
      batting: [],
      pitching: []
    })
    proto.gameProposals = async () => []
    proto.levelPeople = async (kind, id) => {
      asked.push(['people', kind, id])
      return { people, manages: false, admin: false }
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    window.history.replaceState(null, '', path)
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 80))
    })
    const tabs = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].map(node => node.textContent ?? '')
    return {
      tabs,
      asked,
      done: async () => {
        await act(async () => {
          root.unmount()
        })
        host.remove()
        Object.defineProperties(proto, originals)
        window.history.replaceState(null, '', '/')
      }
    }
  }

  it('shows the season’s People at its own address, as Home opens it, for whoever the server lets read them', async () => {
    const seen = await open('/seasons/sea_spring?tab=people', true)
    try {
      expect(seen.tabs).includes('People')
      expect(seen.asked).deep.include(['group', 'season', 'sea_spring'])
      // The address asked for People, and People is what opened.
      expect(seen.asked).deep.include(['people', 'season', 'sea_spring'])
      expect(document.body.textContent).includes('Pat Y')
      expect(window.location.search).includes('tab=people')
    } finally {
      await seen.done()
    }
    const unseen = await open('/seasons/sea_spring?tab=people', false)
    try {
      expect(unseen.tabs).not.includes('People')
      expect(unseen.asked).not.deep.include(['people', 'season', 'sea_spring'])
      expect(window.location.search).not.includes('tab=people')
    } finally {
      await unseen.done()
    }
  })

  it('shows the same tab on the season’s group page', async () => {
    const seen = await open('/groups/season/sea_spring', true)
    try {
      expect(seen.tabs).includes('People')
    } finally {
      await seen.done()
    }
  })

  it('shows a league’s People at either of its addresses, and not to anybody else', async () => {
    for (const path of ['/leagues/lea_demo', '/groups/league/lea_demo']) {
      const seen = await open(path, true)
      try {
        expect(seen.tabs, path).includes('People')
        expect(seen.asked, path).deep.include(['group', 'league', 'lea_demo'])
      } finally {
        await seen.done()
      }
      const unseen = await open(path, false)
      try {
        expect(unseen.tabs, path).includes('Seasons')
        expect(unseen.tabs, path).not.includes('People')
      } finally {
        await unseen.done()
      }
    }
  })
})
