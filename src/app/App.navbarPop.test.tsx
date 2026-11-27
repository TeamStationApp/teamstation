import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AccessibilityInfo, Dimensions } from 'react-native'

import {
  asGameDetail,
  asPlayerDetail,
  asRosterEntry,
  asSeasonGame,
  asSessionUser,
  asTeamSummary,
  TeamStationClient
} from '../common/api'
import { HttpError } from '../common/errors'
import { asGroupDetail, asPublicGroup } from '../common/publicGroups'
import { userIdOfGumbo } from '../common/userId'
import { confirmedChatAgeHooks } from '../test/chatAgeTesting'
import { FakeSearchServer } from '../test/fakeSearchSocket'
import { pageOf, pageOfGames } from '../test/pageOf'
import { App } from './App'
import { scrollFrom } from './components/navScroll.test.helpers'
import { highlightWidth, pillFrame } from './components/tabBarModel'
import { SEARCH_PLACEHOLDER } from './screens/SearchScreen'

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
  // The Shell reads the account's chat age on mount: confirmed here.
  confirmedChatAgeHooks()
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
    proto.home = async () => ({
      teams: [{ ...team, direct: true, source: 'member' }],
      seasons: [],
      leagues: []
    })
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

  // The Search tab finds the league over its socket.
  const searchServer = new FakeSearchServer(() => ({
    results: [
      {
        kind: 'league',
        id: league.id,
        name: league.name,
        imageUrl: null,
        cityLine: null,
        associations: '',
        follow: null
      }
    ]
  }))
  const search = async (value: string): Promise<void> => {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        `input[aria-label="${SEARCH_PLACEHOLDER}"]`
      )!
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await settle()
  }

  async function render(): Promise<() => Promise<void>> {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App searchSocketFactory={searchServer.factory} />)
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

  const expanded = (): boolean =>
    document
      .querySelector('[data-testid="tab-home"]')!
      .textContent!.includes('Home')

  it('keeps both Search entries expanded while scrolling their results', async () => {
    window.history.replaceState(null, '', '/discover?kind=team&follow=1')
    const cleanup = await render()
    try {
      expect(control('Back'), 'follow discovery was pushed on Home').not.equals(
        undefined
      )
      await search('Demo League')
      await scrollFrom(control('Open Demo League')!, 0, 160)
      expect(expanded(), 'pushed Search').equals(true)

      await pressNav('Search', 350)
      await search('Demo League')
      await scrollFrom(control('Open Demo League')!, 0, 160)
      expect(expanded(), 'Search root').equals(true)
    } finally {
      await cleanup()
    }
  })

  it('starts expanded when the window shrinks from a scrolled desktop to a phone', async () => {
    window.history.replaceState(null, '', '/groups/league/league_demo')
    const viewport = document.documentElement
    const previous = Object.getOwnPropertyDescriptor(viewport, 'clientWidth')
    async function resize(width: number): Promise<void> {
      await act(async () => {
        Object.defineProperty(viewport, 'clientWidth', {
          configurable: true,
          value: width
        })
        window.dispatchEvent(new window.Event('resize'))
      })
    }
    let cleanup: (() => Promise<void>) | undefined
    try {
      await resize(1440)
      cleanup = await render()
      await scrollFrom(control('Open Demo Regular')!, 0, 160)
      await resize(390)
      expect(
        expanded(),
        'desktop travel did not compact the returning phone bar'
      ).equals(true)
      await scrollFrom(control('Open Demo Regular')!, 'wheel', 900)
      expect(expanded(), 'the phone is listening again').equals(false)
    } finally {
      await cleanup?.()
      if (previous == null) Reflect.deleteProperty(viewport, 'clientWidth')
      else Object.defineProperty(viewport, 'clientWidth', previous)
      window.dispatchEvent(new window.Event('resize'))
    }
  })

  it('resets scroll history for a new group and keeps it for metadata changes to the same group', async () => {
    window.history.replaceState(null, '', '/groups/league/league_demo')
    const cleanup = await render()
    try {
      await scrollFrom(control('Open Demo Regular')!, 0, 160)
      expect(expanded(), 'league scroller').equals(false)
      await pressIn('League sections', 'Teams')
      expect(expanded(), 'changing the section of the same group').equals(false)
      await pressIn('League sections', 'Seasons')
      await press('Open Demo Regular', 350)
      expect(window.location.pathname).equals('/groups/season/sea_regular')
      expect(expanded(), 'new group before it has scrolled').equals(true)
      await scrollFrom(
        document.querySelector('[aria-label="Season sections"]'),
        260
      )
      expect(expanded(), 'first offset belongs to the new group').equals(true)
    } finally {
      await cleanup()
    }
  })

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
      await search('Demo League')
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

  it('starts the highlight where it was when Search swaps the screen while signed out', async () => {
    // Signed out, Search is the one tab with its own screen, so the bar moves
    // between two screen trees there. Each new bar starts its highlight where
    // the last one left it, and slides from there to its own tab.
    proto.whoAmI = async () => {
      throw new HttpError('unauthorized', 'Sign in')
    }
    const pill = (): HTMLElement =>
      document.querySelector<HTMLElement>('[data-testid="tab-bar-pill"]')!
        .parentElement!
    const pillX = (): number =>
      Number(/translateX\((-?[\d.]+)px\)/.exec(pill().style.transform)![1])
    const slotX = (label: string): number => {
      const tabs = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="tablist"]:not([aria-label]) [role="tab"]'
        )
      ]
      const index = tabs.findIndex(
        tab => tab.getAttribute('aria-label') === label
      )
      const platter = document.querySelector<HTMLElement>(
        '[data-testid="tab-bar-platter"]'
      )!.parentElement!
      const width = parseFloat(platter.style.width)
      return pillFrame(index, width, highlightWidth(width, 5, 4), 5, 4, false).x
    }
    // Motion on: under Reduce Motion the new bar goes straight to its tab.
    const reduceMotion = Object.getOwnPropertyDescriptor(
      AccessibilityInfo,
      'isReduceMotionEnabled'
    )!
    Object.defineProperty(AccessibilityInfo, 'isReduceMotionEnabled', {
      configurable: true,
      value: async () => false
    })
    // A phone's window, so the bar has width to slide across.
    const originalGet = Dimensions.get.bind(Dimensions)
    Dimensions.get = name =>
      name === 'window'
        ? { ...originalGet('window'), width: 390, height: 844 }
        : originalGet(name)
    const cleanup = await render()
    try {
      await settle(200)
      expect(text()).includes('Sign in')
      for (const [from, to] of [
        ['Home', 'Search'],
        ['Search', 'Chat']
      ] as const) {
        const before = pill()
        const start = slotX(from)
        await pressNav(to, 0)
        // A new bar, as the screen tree changed, starting where the old
        // one's highlight was: on the old tab, or a little way along if the
        // old bar had already begun to move. Not on the new tab.
        expect(pill(), from + ' to ' + to).not.equals(before)
        const end = slotX(to)
        expect(end).not.closeTo(start, 1)
        const along = (pillX() - start) / (end - start)
        expect(along, from + ' to ' + to).within(-1e-6, 0.5)
        await settle(400)
        expect(
          document
            .querySelector(
              `[role="tablist"]:not([aria-label]) [aria-label="${to}"]`
            )!
            .getAttribute('aria-selected')
        ).equals('true')
      }
    } finally {
      await cleanup()
      Dimensions.get = originalGet
      Object.defineProperty(
        AccessibilityInfo,
        'isReduceMotionEnabled',
        reduceMotion
      )
    }
  })
})
