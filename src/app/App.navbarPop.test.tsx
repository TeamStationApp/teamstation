import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import {
  asGameDetail,
  asPlayerDetail,
  asRosterEntry,
  asSeasonGame,
  asSessionUser,
  asTeamSummary,
  TeamStationClient
} from '../common/api'
import { asGroupDetail, asPublicGroup } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { pageOf, pageOfGames } from '../test/pageOf'
import { App } from './App'

const playerId = userIdOfGumbo(201)
const team = asTeamSummary({
  id: 'tem_hawks',
  name: 'Demo Hawks',
  shortName: null,
  logoPath: null
})
const game = asSeasonGame({
  id: 'game_demo',
  homeTeamId: 'tem_hawks',
  awayTeamId: 'tem_owls',
  homeTeamName: 'Demo Hawks',
  awayTeamName: 'Demo Owls',
  homeTeamExternal: false,
  awayTeamExternal: false,
  seasonId: 'sea_regular',
  startAt: '2027-04-10T17:00:00Z',
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'none',
  videoCount: 1
})
const detail = asGameDetail({
  nonMemberView: false,
  id: game.id,
  homeTeamId: game.homeTeamId,
  awayTeamId: game.awayTeamId,
  homeTeamName: game.homeTeamName,
  awayTeamName: game.awayTeamName,
  seasonId: game.seasonId,
  startAt: game.startAt,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'none',
  ingestMessage: null,
  videos: []
})
const hawks = asPublicGroup({
  id: 'tem_hawks',
  kind: 'team',
  name: 'Demo Hawks',
  imageUrl: null,
  locality: null
})
const league = asPublicGroup({
  id: 'league_demo',
  kind: 'league',
  name: 'Demo League',
  imageUrl: null,
  locality: null
})
const season = asPublicGroup({
  id: 'sea_regular',
  kind: 'season',
  name: 'Demo Regular',
  imageUrl: null,
  locality: null
})

describe('a navbar press clears that tab', () => {
  const proto = TeamStationClient.prototype
  const originals = Object.getOwnPropertyDescriptors(proto)

  beforeEach(() => {
    proto.whoAmI = async () =>
      asSessionUser({
        id: userIdOfGumbo(1),
        displayName: 'Demo Fan',
        isAdmin: false
      })
    proto.myRoles = async () => {
      throw new Error('offline')
    }
    proto.hasNotifications = async () => false
    proto.teams = async () => [team]
    proto.seasons = async () => []
    proto.ownGroups = async () => []
    proto.follows = async () => []
    proto.recentGame = async () => null
    proto.liveNow = async () => []
    proto.gamesPage = async () => pageOf([game])
    proto.teamGamesPage = async (_id, query) => pageOfGames([game], query)
    proto.game = async () => detail
    proto.roster = async () => [
      asRosterEntry({
        userId: playerId,
        gumboId: 201,
        shortName: 'Alex L',
        jersey: null,
        positions: [],
        isPlayer: true,
        role: 'member',
        section: 'player',
        staffRoles: [],
        inheritedFrom: null,
        avatarUrl: null
      })
    ]
    proto.teamStats = async () => []
    proto.teamPitchingStats = async () => []
    proto.standings = async () => []
    proto.seasonTeams = async () => [team]
    proto.player = async () =>
      asPlayerDetail({
        userId: playerId,
        name: 'Alex L',
        teams: [
          {
            teamId: team.id,
            teamName: team.name,
            logoUrl: null,
            seasonId: null,
            seasonName: null,
            seasonYear: null,
            jersey: null,
            positions: [],
            current: true
          }
        ]
      })
    proto.playerHighlights = async () => ({
      highlights: [],
      nextBefore: null,
      withoutVideo: 0
    })
    proto.discoverGroups = async () => [league]
    proto.group = async ref =>
      asGroupDetail({
        nonMemberView: false,
        canViewPrivate: ref.kind === 'team',
        group:
          ref.kind === 'season' ? season : ref.kind === 'team' ? hawks : league,
        parents: [],
        children: ref.kind === 'league' ? [season] : [],
        participatingSeasons: [],
        competingTeams: [],
        games: [],
        staff: [],
        canManage: false
      })
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    Object.defineProperties(proto, originals)
    window.history.replaceState(null, '', '/')
  })

  const settle = async (ms = 80): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  }
  const control = (label: string): HTMLElement | undefined =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="button"], [role="tab"], [role="link"]'
      )
    ].find(node => (node.getAttribute('aria-label') ?? '') === label)
  const matching = (part: string): HTMLElement | undefined =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="button"], [role="tab"], [role="link"]'
      )
    ].find(node => (node.getAttribute('aria-label') ?? '').includes(part))
  const pressNode = async (
    node: HTMLElement | undefined,
    label: string,
    ms = 80
  ): Promise<void> => {
    expect(node, label).not.equals(undefined)
    await act(async () => {
      node!.click()
    })
    await settle(ms)
  }
  const press = async (label: string, ms = 80): Promise<void> => {
    await pressNode(control(label) ?? matching(label), label, ms)
  }
  const pressNav = async (label: string, ms = 80): Promise<void> => {
    await pressNode(
      document.querySelector<HTMLElement>(
        `[role="tablist"]:not([aria-label]) [aria-label="${label}"]`
      ) ?? undefined,
      label,
      ms
    )
  }
  const pressIn = async (list: string, label: string): Promise<void> => {
    await pressNode(
      document.querySelector<HTMLElement>(
        `[aria-label="${list}"] [aria-label="${label}"]`
      ) ?? undefined,
      `${list} ${label}`
    )
  }
  const text = (): string => document.body.textContent ?? ''

  async function render(): Promise<() => Promise<void>> {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App />)
    })
    await settle()
    return async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  }

  async function openPlayer(
    from: 'home' | 'videos' | 'schedule'
  ): Promise<void> {
    if (from === 'videos') await pressNav('Videos', 350)
    if (from === 'schedule') await pressNav('Schedule', 350)
    if (from === 'home') {
      await press('Demo Hawks', 200)
      await pressIn('Team sections', 'Schedule')
    }
    await press('Demo Owls')
    await press('Demo Hawks')
    await pressIn('Team sections', 'Team')
    await press('Alex L')
    expect(window.location.pathname.startsWith('/players/')).equals(true)
    expect(control('Back')).not.equals(undefined)
  }

  it('returns Home, Videos, Schedule and Search to their roots', async () => {
    const cleanup = await render()
    try {
      expect(text()).includes('Your Home')
      await pressNav('Home')
      expect(window.location.pathname).equals('/')

      await openPlayer('home')
      await pressNav('Home', 350)
      expect(window.location.pathname).equals('/')
      expect(text()).includes('Your Home')
      expect(control('Back')).equals(undefined)

      await openPlayer('videos')
      await pressNav('Videos', 350)
      expect(window.location.pathname).equals('/videos')
      expect(text()).includes('Game videos')
      expect(control('Back')).equals(undefined)

      await openPlayer('schedule')
      await pressNav('Schedule', 350)
      expect(window.location.pathname).equals('/schedule')
      expect(text()).includes('Schedule')
      expect(control('Back')).equals(undefined)

      await pressNav('Search', 350)
      await press('Open Demo League')
      await press('Open Demo Regular')
      expect(window.location.pathname).equals('/groups/season/sea_regular')
      await pressNav('Search', 350)
      expect(window.location.pathname).equals('/discover')
      expect(text()).includes('Discover')
      expect(control('Back')).equals(undefined)
    } finally {
      await cleanup()
    }
  })

  it('keeps a deep screen when the press is for another tab', async () => {
    const cleanup = await render()
    try {
      await openPlayer('home')
      const player = window.location.pathname
      await pressNav('Videos', 350)
      await pressNav('Home', 350)
      expect(window.location.pathname).equals(player)
      expect(control('Back')).not.equals(undefined)
    } finally {
      await cleanup()
    }
  })
})
