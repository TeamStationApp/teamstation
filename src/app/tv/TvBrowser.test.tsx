import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BackHandler } from 'react-native'

import {
  asTeamSummary,
  asVideoGame,
  type TeamStationClient,
  type TvHighlight,
  type VideoCollectionOptions
} from '../../common/api'
import { TvBrowser, type TvPlayRequest } from './TvBrowser'

let root: Root | undefined
let remoteBack: (() => boolean | null | undefined) | undefined
const originalBack = BackHandler.addEventListener.bind(BackHandler)
const games = Array.from({ length: 55 }, (_, i) =>
  asVideoGame({
    id: `game-${i}`,
    homeTeamId: 'home',
    awayTeamId: 'away',
    homeTeamName: 'Demo Hawks',
    awayTeamName: 'Demo Comets',
    homeTeamExternal: false,
    awayTeamExternal: false,
    seasonId: null,
    startAt: new Date(
      Date.UTC(2026, i < 15 ? 9 : 8, 30 - (i % 15))
    ).toISOString(),
    timezone: 'UTC',
    venue: i === 0 ? 'Demo Field' : null,
    status: 'final',
    homeScore: null,
    awayScore: null,
    ingestStatus: 'ok',
    videoCount: 2,
    posterUrl: i === 0 ? 'https://example.test/poster.png' : null,
    homeLogoUrl: 'https://example.test/home.png',
    awayLogoUrl: 'https://example.test/away.png',
    latestVideoId: `video-${i}`,
    latestVideoAt: '2026-10-30T00:00:00Z',
    isLive: i === 0
  })
)
const team = asTeamSummary({
  id: 'home',
  name: 'Demo Hawks',
  shortName: null,
  logoPath: null,
  logoUrl: 'https://example.test/logo.png'
})
const player = {
  userId: 'player',
  gumboId: 101,
  externalIds: [],
  shortName: 'Babe R',
  avatarUrl: null
}
const clip: TvHighlight = {
  eventId: 'event',
  atBatIndex: 1,
  title: 'Home run: Babe R',
  startOffsetSec: 10,
  playOffsetSec: 15,
  endOffsetSec: 20,
  eventType: 'home_run',
  isScoringPlay: true,
  stillUrl: 'https://example.test/clip.png',
  description: null,
  preferred: true
}
const played: TvPlayRequest[] = []
let signedOut = false
let fail = false
let empty = false
let failMore = false
let failSearch = false
const client = {
  videoGames: async (options: VideoCollectionOptions = {}) => {
    if (fail) throw new Error('offline')
    if (failMore && (options.offset ?? 0) > 0) throw new Error('offline')
    if (empty) return []
    return games.slice(
      options.offset ?? 0,
      (options.offset ?? 0) + (options.limit ?? 50)
    )
  },
  videoTeams: async (options: VideoCollectionOptions = {}) => {
    if (options.q !== undefined && failSearch) throw new Error('offline')
    return empty || options.q === 'missing' ? [] : [team]
  },
  videoPlayers: async (options: VideoCollectionOptions = {}) =>
    options.q === 'missing' ? [] : [player],
  myFollows: async () => [{ id: 'home' }],
  tvHighlights: async () => [clip]
} as unknown as TeamStationClient
const pause = async (ms = 20): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
async function render(): Promise<void> {
  BackHandler.addEventListener = (_event, handler) => {
    remoteBack = () =>
      handler({ type: 'hardwareBackPress', timeStamp: Date.now() })
    return {
      remove() {
        remoteBack = undefined
      }
    }
  }
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <TvBrowser
        client={client}
        viewerName="Babe Ruth"
        onPlay={request => {
          played.push(request)
        }}
        onSignOut={() => {
          signedOut = true
        }}
      />
    )
    await pause()
  })
}
async function click(selector: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(selector)
  expect(element, selector).not.equals(null)
  await act(async () => {
    element!.click()
    await pause()
  })
}
async function search(query: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Search teams or players"]'
  )!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, query)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await pause(550)
  })
}
async function button(label: string): Promise<void> {
  if (label === 'Back' || label === 'Close search') {
    await act(async () => {
      remoteBack?.()
      await pause()
    })
    return
  }
  await click(`[role="button"][aria-label="${label}"]`)
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  BackHandler.addEventListener = originalBack
  root = undefined
  document.body.innerHTML = ''
  played.length = 0
  signedOut = false
  fail = false
  empty = false
  failMore = false
  failSearch = false
})
describe('TV browser journeys', () => {
  it('keeps a static thumbnail focus cue with or without artwork and native motion', async () => {
    await render()
    for (const id of ['recent-game-0', 'recent-game-1']) {
      await act(async () => {
        document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.focus()
      })
      const cue = document.querySelector<HTMLElement>(
        `[data-testid="${id}-focus-cue"]`
      )!
      expect(cue).not.equals(null)
      expect(window.getComputedStyle(cue).backgroundColor).equals(
        'rgba(255, 255, 255, 0.16)'
      )
      expect(cue.parentElement!.textContent).not.contains('Demo Hawks')
      expect(document.querySelectorAll('[data-testid$="-focus-cue"]')).length(1)
    }
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="tv-search"]')!.focus()
    })
    expect(document.querySelectorAll('[data-testid$="-focus-cue"]')).length(0)
  })

  it('arbitrates one muted focused preview and restores hero audio after leaving tiles', async () => {
    const configured = client as unknown as Record<string, unknown>
    configured.game = async (id: string) => ({
      videos: [
        {
          id: id.replace('game', 'video'),
          title: 'Primary',
          status: 'ready',
          numCameras: 1,
          durationSec: 60
        }
      ]
    })
    configured.playback = async () => ({
      url: 'https://example.test/preview.mp4'
    })
    try {
      await render()
      await act(async () => {
        await pause()
      })
      const focus = async (selector: string): Promise<void> => {
        await act(async () => {
          document.querySelector<HTMLElement>(selector)!.focus()
          await pause()
        })
        await act(async () => {
          await pause()
        })
      }
      await focus('[data-testid="recent-game-0"]')
      const first = document.querySelector('video')!
      expect(document.querySelectorAll('video')).length(1)
      expect(first.muted).equals(true)
      await act(async () => {
        Object.defineProperty(first, 'duration', {
          configurable: true,
          value: 60
        })
        first.dispatchEvent(new window.Event('durationchange'))
      })
      expect(first.currentTime).equals(30)
      expect(
        document
          .querySelector('[data-testid="recent-game-0"]')!
          .getAttribute('aria-label')
      ).contains('Preview: 30 seconds')
      await focus('[data-testid="recent-game-1"]')
      expect(first.isConnected).equals(false)
      expect(document.querySelectorAll('video')).length(1)
      expect(document.querySelector('video')!.muted).equals(true)
      await focus('[data-testid="tv-search"]')
      expect(document.querySelectorAll('video')).length(1)
      expect(document.querySelector('video')!.muted).equals(false)
    } finally {
      delete configured.game
      delete configured.playback
    }
  })
  it('browses the hero, game and highlight rows, restores the home page and pages the remaining grid', async () => {
    await render()
    expect(document.body.textContent)
      .contains('Recent Games')
      .and.contains('Recent Highlights')
      .and.contains('Recent Demo Hawks')
    await button('▶ Watch Live')
    expect(played[0].game.id).equals('game-0')
    await click('[data-testid="recent-game-1"]')
    expect(played[1].game.id).equals('game-1')
    await click('[data-testid="clip-game-0-event"]')
    expect(played[2].clip?.eventId).equals('event')
    await click('[data-testid="team-home"]')
    expect(document.body.textContent)
      .contains('October 2026')
      .and.contains('September 2026')
    await button('Back')
    failMore = true
    await button('More games')
    expect(document.body.textContent).contains('More games could not load')
    failMore = false
    await button('Retry games')
    expect(document.querySelector('[data-testid="more-game-54"]')).not.equals(
      null
    )
    await button('Sign out')
    expect(signedOut).equals(true)
  })
  it('searches authorized teams and players, handles empty/error results and opens the player page', async () => {
    await render()
    await search('Babe')
    expect(
      document.querySelector('[data-testid="tv-search-results"]')?.textContent
    ).contains('Babe R')
    await button('Babe R')
    expect(
      document.querySelector('[data-testid="tv-page-player"]')?.textContent
    )
      .contains('Babe R')
      .and.contains('Recent Games')
    await button('Back')
    await search('missing')
    expect(document.body.textContent).contains('No accessible teams or players')
    await button('Close search')
    failSearch = true
    await search('Demo')
    expect(document.body.textContent).contains('Search is unavailable')
    failSearch = false
    await button('Retry search')
    await act(async () => {
      await pause(550)
    })
    await button('Demo Hawks')
    expect(document.querySelector('[data-testid="tv-page-home"]')).not.equals(
      null
    )
    await button('Back')
  })
  it('recovers loading errors and shows an honest empty state', async () => {
    fail = true
    await render()
    expect(document.body.textContent).contains('Games are unavailable')
    fail = false
    empty = true
    await button('Retry games')
    expect(document.body.textContent).contains('No games are available yet.')
  })
})
