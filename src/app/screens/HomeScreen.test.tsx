import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  GameDetail,
  LiveNow,
  Playback,
  SeasonGame,
  SeasonSummary,
  TeamStationClient,
  TeamSummary,
  UserMatch
} from '../../common/api'
import { asSeasonGame, asTeamSummary, asUserMatch } from '../../common/api'
import { asPublicGroup, type PublicGroup } from '../../common/publicGroups'
import { App } from '../App'
import { parseRoute, routePath } from '../navigation/routes'
import { currentRoute, showRoute } from '../navigation/useAddressBar'
import { ThemeProvider } from '../theme/ThemeContext'
import { HomeScreen } from './HomeScreen'

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The screen's half-minute look at what is live, held so a test can run it
 * when it likes instead of waiting thirty seconds.
 */
function liveClock(): {
  tick: () => Promise<void>
  running: () => number
  restore: () => void
} {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const looks = new Map<unknown, () => void>()
  let nextId = 0
  globalThis.setInterval = ((
    callback: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (ms !== 30_000) return realSet(callback, ms, ...rest)
    const id = { look: ++nextId }
    looks.set(id, callback)
    return id
  }) as unknown as typeof setInterval
  globalThis.clearInterval = (id: unknown) => {
    if (looks.delete(id)) return
    realClear(id as Parameters<typeof clearInterval>[0])
  }
  return {
    running: () => looks.size,
    tick: async () => {
      await act(async () => {
        for (const callback of Array.from(looks.values())) callback()
        await delay(10)
      })
    },
    restore: () => {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  }
}
let clock: ReturnType<typeof liveClock> | undefined

/** A `<video>` that will take a URL, so the card can be seen to play one. */
function playableVideo(): () => void {
  const proto = window.HTMLMediaElement.prototype
  const canPlayType = Object.getOwnPropertyDescriptor(proto, 'canPlayType')
  const load = Object.getOwnPropertyDescriptor(proto, 'load')
  const play = Object.getOwnPropertyDescriptor(proto, 'play')
  Object.defineProperty(proto, 'canPlayType', {
    configurable: true,
    value: () => 'maybe'
  })
  Object.defineProperty(proto, 'load', {
    configurable: true,
    value: () => undefined
  })
  Object.defineProperty(proto, 'play', {
    configurable: true,
    value: async () => {
      await Promise.resolve()
    }
  })
  return () => {
    if (canPlayType != null)
      Object.defineProperty(proto, 'canPlayType', canPlayType)
    if (load != null) Object.defineProperty(proto, 'load', load)
    if (play != null) Object.defineProperty(proto, 'play', play)
  }
}
let restoreVideo: (() => void) | undefined

function team(
  id: string,
  name: string,
  patch: Partial<TeamSummary> = {}
): TeamSummary {
  return asTeamSummary({
    id,
    name,
    shortName: null,
    logoPath: null,
    logoUrl: null,
    record: null,
    kind: 'full',
    seasonCategory: 'inSeason',
    ...patch
  })
}

function season(
  id: string,
  name: string,
  patch: Partial<SeasonSummary> = {}
): SeasonSummary {
  return {
    id,
    leagueId: null,
    name,
    year: 2026,
    term: null,
    ageGroup: null,
    teams: 6,
    games: 30,
    videos: 12,
    logoUrl: null,
    ...patch
  }
}

function recentGame(patch: Partial<SeasonGame> = {}): SeasonGame {
  return asSeasonGame({
    id: 'gam_recent',
    homeTeamId: 'tem_sox',
    awayTeamId: 'tem_hawks',
    homeTeamName: 'Bay Stars',
    awayTeamName: 'Alta Hawks',
    homeTeamExternal: false,
    awayTeamExternal: false,
    seasonId: 'sea_spring',
    startAt: '2026-05-20T17:00:00.000Z',
    venue: 'Field 3',
    status: 'final',
    homeScore: 4,
    awayScore: 7,
    ingestStatus: 'done',
    videoCount: 2,
    durationSec: 5400,
    posterUrl: null,
    homeLogoUrl: null,
    awayLogoUrl: null,
    isLive: false,
    externalIds: [],
    exhibition: false,
    timezone: 'UTC',
    pendingApproval: false,
    pendingRequestId: null,
    ...patch
  })
}

function liveGame(
  videoId: string,
  gameId: string,
  away: string,
  home: string,
  patch: Partial<LiveNow> = {}
): LiveNow {
  return {
    videoId,
    gameId,
    title: `${away} @ ${home}`,
    awayTeamName: away,
    homeTeamName: home,
    startedAt: null,
    gameStartAt: '2026-05-20T17:00:00.000Z',
    angles: 1,
    ...patch
  }
}

function playback(videoId: string, url: string | null): Playback {
  return {
    videoId,
    storage: 'space',
    url,
    expiresAt: null,
    durationSec: null,
    unavailable: url == null
  }
}

function guarded(
  userId: number,
  shortName: string,
  avatarUrl: string | null = null
): UserMatch {
  return asUserMatch({ userId, externalIds: [], shortName, avatarUrl })
}

function league(id: string, name: string): PublicGroup {
  return asPublicGroup({
    id,
    kind: 'league',
    name,
    imageUrl: null,
    locality: null
  })
}

interface Setup {
  follows?: () => Promise<PublicGroup[]>
  /** The players this person guards; given, Home can open a player. */
  players?: () => Promise<UserMatch[]>
  /** Their own leagues, seasons and teams; given, Home can open a group. */
  groups?: () => Promise<PublicGroup[]>
  teams?: () => Promise<TeamSummary[]>
  seasons?: () => Promise<SeasonSummary[]>
  recent?: () => Promise<SeasonGame | null>
  live?: () => Promise<LiveNow[]>
  videos?: GameDetail['videos']
  playbackUrl?: (videoId: string) => string | null
}

interface Calls {
  teams: TeamSummary[]
  seasons: SeasonSummary[]
  games: Array<{ gameId: string; title: string; options?: unknown }>
  players: unknown[][]
  guardedAsked: number
  playbacks: string[]
  details: string[]
}

async function mount(setup: Setup = {}): Promise<Calls> {
  const calls: Calls = {
    teams: [],
    seasons: [],
    games: [],
    players: [],
    guardedAsked: 0,
    playbacks: [],
    details: []
  }
  const client = {
    guardedPlayers: async () => {
      calls.guardedAsked++
      return await (setup.players ?? (async () => []))()
    },
    ownGroups: setup.groups ?? (async () => []),
    follows: setup.follows ?? (async () => []),
    teams: setup.teams ?? (async () => []),
    seasons: setup.seasons ?? (async () => []),
    recentGame: setup.recent ?? (async () => null),
    liveNow: setup.live ?? (async () => []),
    game: async (gameId: string) => {
      calls.details.push(gameId)
      return { id: gameId, videos: setup.videos ?? [] }
    },
    playback: async (videoId: string) => {
      calls.playbacks.push(videoId)
      return playback(
        videoId,
        setup.playbackUrl == null
          ? `https://video.example/${videoId}.m3u8`
          : setup.playbackUrl(videoId)
      )
    }
  } as unknown as TeamStationClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <HomeScreen
          client={client}
          onCreateGroup={() => undefined}
          onOpenTeam={opened => calls.teams.push(opened)}
          onOpenSeason={opened => calls.seasons.push(opened)}
          onOpenGame={(gameId, title, options) =>
            calls.games.push({ gameId, title, options })
          }
          onOpenGroup={setup.groups == null ? undefined : () => undefined}
          onOpenPlayer={
            setup.players == null
              ? undefined
              : (...args) => {
                  calls.players.push(args)
                }
          }
        />
      </ThemeProvider>
    )
    await delay(10)
  })
  return calls
}

function text(): string {
  return document.body.textContent ?? ''
}

function labelled(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(found, label).not.equals(null)
  return found!
}

/** A button by the words on it; an icon's name may sit in front of them. */
function button(words: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].filter(node => (node.textContent ?? '').endsWith(words))
  expect(found, words).has.lengthOf(1)
  return found[0]
}

function hasButton(words: string): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].some(
    node => (node.textContent ?? '').endsWith(words)
  )
}

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await delay(10)
  })
}

function startedAt(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
}

describe('the home screen', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    clock?.restore()
    clock = undefined
    restoreVideo?.()
    restoreVideo = undefined
  })

  it('says it is loading until the teams and seasons arrive', async function () {
    let finish: (teams: TeamSummary[]) => void = () => undefined
    await mount({
      teams: async () =>
        await new Promise<TeamSummary[]>(resolve => {
          finish = resolve
        })
    })
    expect(text()).equals('Loading…')
    await act(async () => {
      finish([team('tem_hawks', 'Alta Hawks')])
      await delay(10)
    })
    expect(text()).not.includes('Loading…')
    expect(text()).includes('Alta Hawks')
  })

  it('draws nothing from an answer that arrives after it has gone', async function () {
    let finish: (teams: TeamSummary[]) => void = () => undefined
    let finishLive: (live: LiveNow[]) => void = () => undefined
    let finishRecent: (game: SeasonGame | null) => void = () => undefined
    let askedRecent = false
    await mount({
      teams: async () =>
        await new Promise<TeamSummary[]>(resolve => {
          finish = resolve
        }),
      live: async () =>
        await new Promise<LiveNow[]>(resolve => {
          finishLive = resolve
        })
    })
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await act(async () => {
      finish([team('tem_hawks', 'Alta Hawks')])
      finishLive([liveGame('vid_1', 'gam_1', 'Alta Hawks', 'Bay Stars')])
      await delay(10)
    })
    expect(text()).equals('')

    // Gone between the lists and the recent game: that is not asked for.
    await mount({
      recent: async () =>
        await new Promise<SeasonGame | null>(resolve => {
          askedRecent = true
          finishRecent = resolve
        })
    })
    expect(askedRecent).equals(true)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await act(async () => {
      finishRecent(recentGame())
      await delay(10)
    })
    expect(text()).equals('')
  })

  it('shows what went wrong when the lists cannot be had', async function () {
    await mount({
      teams: async () => {
        throw new Error('The server answered 500')
      }
    })
    expect(text()).includes('The server answered 500')
    expect(text()).not.includes('Loading…')
  })

  it('says it cannot load when the failure is not an Error', async function () {
    await mount({
      seasons: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'nope'
      }
    })
    expect(text()).includes('Cannot load')
  })

  it('offers creation actions and hides empty sections', async function () {
    await mount()
    for (const action of ['Create League', 'Create Season', 'Create Team'])
      expect(text()).includes(action)
    expect(text()).not.includes('YOUR TEAMS')
    expect(text()).not.includes('SEASONS')
    expect(text()).not.includes('LIVE NOW')
    expect(text()).not.includes('RECENT GAME')
  })

  it('keeps Home Add and Create available through recent-game refresh failure and recovery', async function () {
    clock = liveClock()
    let failed = false
    await mount({
      recent: async () => {
        if (failed) throw new Error('Recent game unavailable')
        return recentGame()
      }
    })
    failed = true
    await clock.tick()
    expect(text()).includes('Recent game unavailable')
    for (const action of ['Create League', 'Create Season', 'Create Team'])
      expect(text()).includes(action)
    failed = false
    await clock.tick()
    expect(text()).not.includes('Recent game unavailable')
    expect(text()).includes('RECENT GAME')
    expect(text()).includes('Create Team')
  })

  it('does not clear a group-loading error when the recent-game refresh recovers', async function () {
    clock = liveClock()
    await mount({
      teams: async () => {
        throw new Error('Teams unavailable')
      }
    })
    await clock.tick()
    expect(text()).includes('Teams unavailable')
    expect(text()).not.includes('Create Team')
  })

  it('lists teams above seasons, and opens whichever is tapped', async function () {
    const hawks = team('tem_hawks', 'Alta Hawks', {
      shortName: 'Hawks',
      record: { w: 12, l: 3, t: 0, seasonName: 'QPLL Spring 2026' }
    })
    const sox = team('tem_sox', 'Bay Stars', {
      shortName: 'Sox',
      record: { w: 5, l: 6, t: 1, seasonName: null }
    })
    const rays = team('tem_rays', 'Rays', { shortName: 'Rays' })
    const owls = team('tem_owls', 'Owls')
    const spring = season('sea_spring', 'QPLL Spring 2026', {
      term: 'Spring'
    })
    const fall = season('sea_fall', 'Fall Ball 2025')
    const calls = await mount({
      teams: async () => [hawks, sox, rays, owls],
      seasons: async () => [spring, fall]
    })

    const page = text()
    expect(page).includes('YOUR TEAMS')
    expect(page).includes('SEASONS')
    labelled('Create Season')
    expect(page.indexOf('YOUR TEAMS')).lessThan(page.indexOf('SEASONS'))
    expect(page).not.includes('Nothing to watch yet')

    // A record reads with its season, or else the short name; a tie only
    // when there was one; and a team with neither has no second line.
    labelled('Alta Hawks, QPLL Spring 2026 · 12–3')
    labelled('Bay Stars, Sox · 5–6–1')
    labelled('Rays, Rays')
    labelled('Owls')
    labelled('QPLL Spring 2026, 6 teams · 30 games · 12 videos')
    expect(page).includes('Spring')

    await press(labelled('Bay Stars, Sox · 5–6–1'))
    expect(calls.teams).deep.equals([sox])
    await press(labelled('Fall Ball 2025, 6 teams · 30 games · 12 videos'))
    expect(calls.seasons).deep.equals([fall])
  })

  it('plays the recent game in its card, and opens it to watch or to the box score', async function () {
    restoreVideo = playableVideo()
    const calls = await mount({
      teams: async () => [team('tem_hawks', 'Alta Hawks')],
      recent: async () =>
        recentGame({ posterUrl: 'https://video.example/poster.jpg' }),
      videos: [
        { id: 'vid_processing', status: 'processing' },
        { id: 'vid_ready', status: 'ready' }
      ] as unknown as GameDetail['videos']
    })
    expect(text()).includes('RECENT GAME')
    expect(text()).includes('Field 3')
    expect(text()).includes('Alta Hawks')
    expect(text()).includes('Bay Stars')
    expect(text()).includes('FINAL')
    expect(calls.details).deep.equals(['gam_recent'])
    expect(calls.playbacks).deep.equals(['vid_ready'])
    expect(document.querySelector('video')?.getAttribute('src')).equals(
      'https://video.example/vid_ready.m3u8'
    )

    await press(button('Watch'))
    await press(button('Box Score'))
    expect(calls.games).deep.equals([
      {
        gameId: 'gam_recent',
        title: 'Alta Hawks @ Bay Stars',
        options: { autoPlay: true }
      },
      {
        gameId: 'gam_recent',
        title: 'Alta Hawks @ Bay Stars',
        options: { tab: 'boxScore' }
      }
    ])
  })

  it('offers only the box score for a recent game nobody filmed', async function () {
    const calls = await mount({
      recent: async () => recentGame({ videoCount: 0, venue: null })
    })
    expect(text()).includes('RECENT GAME')
    expect(text()).not.includes('Field 3')
    expect(hasButton('Watch')).equals(false)
    expect(hasButton('Box Score')).equals(true)
    // Nothing to play, so nothing is asked about its video.
    expect(calls.details).deep.equals([])
    expect(document.querySelector('video')).equals(null)
  })

  it('leaves the recent card still when its video cannot be played', async function () {
    const nothingPlayable = await mount({
      recent: async () => recentGame(),
      videos: [
        { id: 'vid_failed', status: 'failed' }
      ] as unknown as GameDetail['videos']
    })
    expect(nothingPlayable.details).deep.equals(['gam_recent'])
    expect(nothingPlayable.playbacks).deep.equals([])
    expect(document.querySelector('video')).equals(null)
    await act(async () => {
      root?.unmount()
    })

    const noFiles = await mount({
      recent: async () => recentGame(),
      videos: [
        { id: 'vid_live', status: 'live' }
      ] as unknown as GameDetail['videos'],
      playbackUrl: () => null
    })
    expect(noFiles.playbacks).deep.equals(['vid_live'])
    expect(document.querySelector('video')).equals(null)
    expect(text()).includes('RECENT GAME')
  })

  it('leads with a game being played now, and lists any other below it', async function () {
    clock = liveClock()
    restoreVideo = playableVideo()
    const started = '2026-05-20T17:18:00.000Z'
    let live = [
      liveGame('vid_a', 'gam_a', 'Alta Hawks', 'Bay Stars', {
        startedAt: started,
        angles: 3
      }),
      liveGame('vid_b', 'gam_b', 'Rays', 'Owls', {
        startedAt: started,
        angles: 2
      }),
      liveGame('vid_c', 'gam_c', 'Cubs', 'Reds')
    ]
    const calls = await mount({ live: async () => live })

    expect(text()).includes('LIVE NOW')
    labelled('Live now')
    expect(text()).includes(
      `Alta Hawks at Bay Stars · started ${startedAt(started)} · 3 cameras`
    )
    expect(calls.playbacks).deep.equals(['vid_a'])
    expect(document.querySelector('video')?.getAttribute('src')).equals(
      'https://video.example/vid_a.m3u8'
    )
    const second = labelled(
      `Rays @ Owls, started ${startedAt(started)} · 2 cameras`
    )
    expect(second.textContent).includes('live')
    // Nothing more to say about the third than its teams.
    const third = [
      ...document.querySelectorAll<HTMLElement>('[role="button"]')
    ].find(node => (node.getAttribute('aria-label') ?? '').startsWith('Cubs'))
    expect(third?.textContent).includes('Cubs @ Reds')

    await press(button('Watch live'))
    await press(second)
    await press(third!)
    expect(calls.games).deep.equals([
      {
        gameId: 'gam_a',
        title: 'Alta Hawks @ Bay Stars',
        options: { autoPlay: true }
      },
      { gameId: 'gam_b', title: 'Rays @ Owls', options: { autoPlay: true } },
      { gameId: 'gam_c', title: 'Cubs @ Reds', options: { autoPlay: true } }
    ])

    // The same game still playing keeps the address it has.
    expect(clock.running()).equals(1)
    await clock.tick()
    expect(calls.playbacks).deep.equals(['vid_a'])

    // A different game in the lead is asked for afresh.
    live = [liveGame('vid_b', 'gam_b', 'Rays', 'Owls')]
    await clock.tick()
    expect(calls.playbacks).deep.equals(['vid_a', 'vid_b'])
    expect(text()).includes('Rays at Owls')
    expect(text()).not.includes(' · started')

    // And when it ends, the block goes.
    live = []
    await clock.tick()
    expect(text()).not.includes('LIVE NOW')
    expect(hasButton('Watch live')).equals(false)
  })

  it('keeps asking about a live game whose address is not ready yet', async function () {
    clock = liveClock()
    let url: string | null = null
    const calls = await mount({
      live: async () => [liveGame('vid_a', 'gam_a', 'Alta Hawks', 'Bay Stars')],
      playbackUrl: () => url
    })
    expect(text()).includes('LIVE NOW')
    expect(calls.playbacks).deep.equals(['vid_a'])
    expect(document.querySelector('video')).equals(null)

    url = 'https://video.example/vid_a.m3u8'
    await clock.tick()
    expect(calls.playbacks).deep.equals(['vid_a', 'vid_a'])
    expect(document.querySelector('video')).not.equals(null)
  })

  it('treats a failed look at what is live as nothing being live', async function () {
    clock = liveClock()
    await mount({
      teams: async () => [team('tem_hawks', 'Alta Hawks')],
      live: async () => {
        throw new Error('offline')
      }
    })
    expect(text()).not.includes('LIVE NOW')
    expect(text()).not.includes('offline')
    await clock.tick()
    expect(text()).includes('Alta Hawks')
    // The timer goes with the screen.
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(clock.running()).equals(0)
  })
})

/** What each large card says under its title. */
const CARD_WORDS = {
  'Create League': 'Create an organization that runs multiple seasons',
  'Create Season': 'Create a season or tournament with a game schedule',
  'Create Team': 'A team is a collection of coaches, staff, and players'
}

/**
 * The large card to create `title`: the one control with that name, with its
 * description in it, so never a small button beside it.
 */
function largeCard(title: keyof typeof CARD_WORDS): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].filter(
    node =>
      node.getAttribute('aria-label') === title ||
      (node.textContent ?? '').startsWith(title)
  )
  expect(found, title).has.lengthOf(1)
  expect(found[0].textContent).includes(CARD_WORDS[title])
  return found[0]
}

describe('the home screen’s players', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('lists Your Players above Your teams, and opens a player with no team', async function () {
    const calls = await mount({
      players: async () => [
        guarded(7, 'Jordan P', 'https://img.example/jordan.jpg'),
        guarded(8, 'Avery S')
      ],
      teams: async () => [team('tem_hawks', 'Alta Hawks')]
    })
    const page = text()
    expect(page).includes('YOUR PLAYERS')
    expect(page.indexOf('YOUR PLAYERS')).lessThan(page.indexOf('YOUR TEAMS'))
    expect(page.indexOf('Avery S')).lessThan(page.indexOf('Alta Hawks'))
    // In the order the server sorted them, the picture where there is one.
    expect(page.indexOf('Jordan P')).lessThan(page.indexOf('Avery S'))
    expect(
      document.querySelector('img[src="https://img.example/jordan.jpg"]')
    ).not.equals(null)
    labelled('Avery S')

    await press(labelled('Jordan P'))
    await press(labelled('Avery S'))
    // A name and nothing else: no team, so the page opens on the career.
    expect(calls.players).deep.equals([
      [7, 'Jordan P'],
      [8, 'Avery S']
    ])
    expect(calls.teams).deep.equals([])
  })

  it('hides Your Players when there are none, or they cannot be read', async function () {
    const none = await mount({
      players: async () => [],
      teams: async () => [team('tem_hawks', 'Alta Hawks')]
    })
    expect(none.guardedAsked).equals(1)
    expect(text()).includes('YOUR TEAMS')
    expect(text()).not.includes('YOUR PLAYERS')
    await act(async () => {
      root?.unmount()
    })

    await mount({
      players: async () => {
        throw new Error('offline')
      },
      teams: async () => [team('tem_hawks', 'Alta Hawks')]
    })
    expect(text()).includes('Alta Hawks')
    expect(text()).not.includes('YOUR PLAYERS')
    expect(text()).not.includes('offline')
    await act(async () => {
      root?.unmount()
    })

    // A Home that cannot open a player does not ask for them.
    const unasked = await mount({
      teams: async () => [team('tem_hawks', 'Alta Hawks')]
    })
    expect(unasked.guardedAsked).equals(0)
  })

  it('reads nothing again when the shell hands over a new way to open a player', async function () {
    const asked = { teams: 0, guarded: 0, recent: 0 }
    const opened: string[] = []
    const client = {
      guardedPlayers: async () => {
        asked.guarded++
        return [guarded(7, 'Jordan P')]
      },
      ownGroups: async () => [],
      follows: async () => [],
      teams: async () => {
        asked.teams++
        return [team('tem_hawks', 'Alta Hawks')]
      },
      seasons: async () => [],
      recentGame: async () => {
        asked.recent++
        return null
      },
      liveNow: async () => []
    } as unknown as TeamStationClient
    const home = (which: string): React.ReactElement => (
      <ThemeProvider>
        <HomeScreen
          client={client}
          onCreateGroup={() => undefined}
          onOpenTeam={() => undefined}
          onOpenSeason={() => undefined}
          onOpenGame={() => undefined}
          onOpenPlayer={() => {
            opened.push(which)
          }}
        />
      </ThemeProvider>
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(home('first'))
      await delay(10)
    })
    for (const which of ['second', 'third'])
      await act(async () => {
        root!.render(home(which))
        await delay(10)
      })
    expect(asked).deep.equals({ teams: 1, guarded: 1, recent: 1 })
    // The newest one is the one a tap uses.
    await press(labelled('Jordan P'))
    expect(opened).deep.equals(['third'])
  })
})

describe('the home screen’s create cards', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('leads with all three large cards when there is nothing at all', async function () {
    await mount({
      groups: async () => [],
      recent: async () => recentGame({ videoCount: 0 })
    })
    const page = text()
    for (const title of [
      'Create League',
      'Create Season',
      'Create Team'
    ] as const)
      expect(page.indexOf(CARD_WORDS[title])).lessThan(
        page.indexOf('RECENT GAME')
      )
    largeCard('Create League')
    largeCard('Create Season')
    largeCard('Create Team')
  })

  it('shows two missing kinds as large cards at the bottom', async function () {
    await mount({
      players: async () => [guarded(7, 'Jordan P')],
      groups: async () => [],
      teams: async () => [team('tem_rookies', 'Demo Rookies')]
    })
    const page = text()
    largeCard('Create League')
    largeCard('Create Season')
    // The kind there is keeps its own Create beside its title.
    expect(labelled('Create Team').textContent).equals('Create Team')
    expect(page.indexOf('YOUR PLAYERS')).lessThan(page.indexOf('YOUR TEAMS'))
    expect(page.indexOf('Demo Rookies')).lessThan(
      page.indexOf(CARD_WORDS['Create League'])
    )
    expect(page.indexOf(CARD_WORDS['Create League'])).lessThan(
      page.indexOf(CARD_WORDS['Create Season'])
    )
    expect(
      page
        .trim()
        .endsWith(
          'Spring 2027, Fall 2026, or 2026 Labor Day Classic. Seasons can be standalone or managed by a league.'
        )
    ).equals(true)
    expect(page).not.includes(CARD_WORDS['Create Team'])
  })

  it('shows one missing kind as a large card at the bottom', async function () {
    await mount({
      groups: async () => [league('lea_demo', 'Demo League')],
      seasons: async () => [season('sea_spring', 'Demo Spring')]
    })
    const page = text()
    largeCard('Create Team')
    expect(page.indexOf('YOUR LEAGUES')).lessThan(
      page.indexOf(CARD_WORDS['Create Team'])
    )
    expect(
      page.trim().endsWith('its parent seasons, or its parent league.')
    ).equals(true)
    expect(page).not.includes(CARD_WORDS['Create League'])
    expect(page).not.includes(CARD_WORDS['Create Season'])
    await act(async () => {
      root?.unmount()
    })

    // A league missing, after the teams and the seasons.
    await mount({
      groups: async () => [],
      teams: async () => [team('tem_rookies', 'Demo Rookies')],
      seasons: async () => [season('sea_spring', 'Demo Spring')]
    })
    largeCard('Create League')
    expect(text().indexOf('Demo Spring')).lessThan(
      text().indexOf(CARD_WORDS['Create League'])
    )
    expect(text()).not.includes(CARD_WORDS['Create Season'])
  })
})

describe('a player opened from Home, through the app', function () {
  const originalFetch = globalThis.fetch
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    globalThis.fetch = originalFetch
  })

  it('opens the player’s page with no team on the address', async function () {
    globalThis.fetch = async input => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const path = url.split('?')[0]
      const data = path.endsWith('/auth/me')
        ? { id: 100, displayName: 'Demo Guardian', isAdmin: false }
        : path.endsWith('/me/roles')
          ? { teams: {}, guardianOf: [7] }
          : url.endsWith('/users?guardedBy=me')
            ? [{ userId: 7, externalIds: [], shortName: 'Jordan P' }]
            : path.endsWith('/players/7')
              ? { userId: 7, name: 'Jordan P', teams: [] }
              : path.endsWith('/players/7/highlights')
                ? { highlights: [], nextBefore: null, withoutVideo: 0 }
                : []
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    showRoute(parseRoute('/', ''), true)
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<App />)
      await delay(50)
    })
    expect(text()).includes('YOUR PLAYERS')
    await press(labelled('Jordan P'))
    await act(async () => {
      await delay(50)
    })
    expect(routePath(currentRoute())).equals('/players/7')
  })
})

describe('followed team identity on Home', () => {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })
  it('opens followed teams with name-hashed initials while preserving league defaults', async () => {
    const group = asPublicGroup({
      kind: 'team',
      id: 'tem_followed',
      name: 'Winter Wolves',
      imageUrl: null,
      locality: null
    })
    await mount({
      groups: async () => [],
      follows: async () => [group, league('lea_followed', 'Willow Woods')]
    })
    expect(text()).includes('Winter Wolves').and.includes('Willow Woods')
    const row = labelled('Winter Wolves')
    expect(row.textContent).includes('WW')
    expect(row.querySelector('[role="img"]')).equals(null)
  })
})
