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
  TeamSummary
} from '../../common/api'
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
  return {
    id,
    name,
    shortName: null,
    logoPath: null,
    logoUrl: null,
    record: null,
    ...patch
  }
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
  return {
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
    ...patch
  }
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

interface Setup {
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
  playbacks: string[]
  details: string[]
}

async function mount(setup: Setup = {}): Promise<Calls> {
  const calls: Calls = {
    teams: [],
    seasons: [],
    games: [],
    playbacks: [],
    details: []
  }
  const client = {
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
          onOpenTeam={opened => calls.teams.push(opened)}
          onOpenSeason={opened => calls.seasons.push(opened)}
          onOpenGame={(gameId, title, options) =>
            calls.games.push({ gameId, title, options })
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

  it('tells somebody on no team and in no season that it will fill in', async function () {
    await mount()
    expect(text()).includes('Nothing to watch yet')
    expect(text()).includes('Ask your league administrator to add you')
    expect(text()).not.includes('YOUR TEAMS')
    expect(text()).not.includes('SEASONS')
    expect(text()).not.includes('LIVE NOW')
    expect(text()).not.includes('RECENT GAME')
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
    expect(page).includes('Current & past')
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
