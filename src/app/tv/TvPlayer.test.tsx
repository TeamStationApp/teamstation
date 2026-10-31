import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asVideoGame, type TeamStationClient } from '../../common/api'
import { timelineFor } from './playbackTimeline'
import { TvPlayer } from './TvPlayer'

const game = asVideoGame({
  id: 'game',
  homeTeamId: 'home',
  awayTeamId: 'away',
  homeTeamName: 'Hosts',
  awayTeamName: 'Visitors',
  homeTeamExternal: false,
  awayTeamExternal: false,
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'final',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'ok',
  videoCount: 4,
  latestVideoId: 'video',
  latestVideoAt: '2026-10-01T00:00:00Z'
})
let root: Root | undefined
let count = 4
let fail = false
let pending = false
let live = false
let mixed = false
let closed = false
const client = {
  game: async () => {
    if (fail) throw new Error('Game unavailable')
    return {
      videos: [
        ...Array.from({ length: count }, (_, i) => ({
          id: String(i),
          title: `Angle ${i}`,
          numCameras: 1,
          status: live ? 'live' : 'ready'
        })),
        { id: 'mosaic', title: 'Mosaic', numCameras: 4, status: 'ready' },
        { id: 'processing', numCameras: 1, status: 'processing' }
      ]
    }
  },
  wallTimeline: async () => timelineFor('2026-10-01T00:00:00Z'),
  scoreboardTimeline: async () => ({ steps: [], version: 'fixture' }),
  lineScore: async () => ({
    steps: [],
    version: 'fixture',
    teams: { home: 'Hosts', away: 'Visitors' }
  }),
  gameEvents: async () => ({ plays: [], currentPlay: null }),
  tvHighlights: async () => [
    {
      eventId: 'clip',
      title: 'Home run',
      startOffsetSec: 5,
      playOffsetSec: 6,
      endOffsetSec: 8,
      stillUrl: 'https://example.test/still.jpg'
    }
  ],
  playback: async (id: string) => {
    if (mixed && id === '0') throw new Error('Camera unavailable')
    return {
      url:
        pending || (mixed && id === '1')
          ? null
          : `https://example.test/${id}.mp4`
    }
  }
} as unknown as TeamStationClient
const pause = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 20))
}
async function render(): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <TvPlayer
        client={client}
        request={{ game }}
        onClose={() => {
          closed = true
        }}
      />
    )
    await pause()
  })
}
async function press(label: string): Promise<void> {
  const target = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(target, label).not.equals(null)
  await act(async () => {
    target!.click()
    await pause()
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  document.body.innerHTML = ''
  root = undefined
  count = 4
  mixed = false
  fail = false
  pending = false
  live = false
  closed = false
})
describe('TV game playback entry', () => {
  it('opens four authorized single-camera sources and enlarges the same player without remounting', async () => {
    await render()
    const videos = [...document.querySelectorAll('video')]
    expect(videos).length(4)
    await press('Camera Angle 1')
    expect([...document.querySelectorAll('video')]).deep.equals(videos)
    await press('Back to cameras')
    expect(closed).equals(false)
    await press('Back to games')
    expect(closed).equals(true)
  })
  it('toggles persistent surfaces, transfers audio, seeks highlights and reopens their list while playback continues', async () => {
    await render()
    const videos = [...document.querySelectorAll('video')]
    await act(async () => {
      for (const video of videos) {
        Object.defineProperty(video, 'duration', {
          value: 60,
          configurable: true
        })
        video.dispatchEvent(
          new window.Event('durationchange', { bubbles: true })
        )
      }
      await pause()
    })
    expect(
      document.querySelector('[data-testid="tv-cameras-panel"]')
    ).not.equals(null)
    await press('Toggle Angle 0')
    expect([...document.querySelectorAll('video')]).deep.equals(videos)
    expect(videos[0].muted).equals(true)
    expect(videos[1].muted).equals(false)
    await press('Toggle Angle 0')
    await press('Close panel')
    await press('Highlights')
    await press('Home run')
    expect(
      document.querySelector('[data-testid="tv-highlights-panel"]')
    ).equals(null)
    expect(videos.map(v => v.currentTime)).deep.equals([5, 5, 5, 5])
    await act(async () => {
      videos[0].dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
      await pause()
    })
    await act(async () => {
      videos[0].currentTime = 9
      videos[0].dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
      await pause()
    })
    expect(
      document.querySelector('[data-testid="tv-highlights-panel"]')
    ).not.equals(null)
    expect(videos[0].currentTime).equals(9)
    await press('Close panel')
    await press('Box score')
    expect(document.body.textContent).contains(
      'Statistics unavailable at this point'
    )
    await press('Team and player statistics')
    expect(document.body.textContent).contains('Player statistics unavailable')
    await press('Close panel')
    await press('Pause')
    await press('Play')
    await press('−10 seconds')
    expect(videos[0].currentTime).equals(0)
    await press('+10 seconds')
    expect(videos[0].currentTime).equals(10)
    await press('Back to games')
    expect(closed).equals(true)
  })
  it('keeps the native live opening position instead of seeking to the first pitch', async () => {
    live = true
    await render()
    const videos = [...document.querySelectorAll('video')]
    await act(async () => {
      for (const video of videos) {
        Object.defineProperty(video, 'duration', {
          configurable: true,
          value: 60
        })
        video.currentTime = 40
        video.dispatchEvent(
          new window.Event('durationchange', { bubbles: true })
        )
      }
      await pause()
    })
    expect(videos.map(video => video.currentTime)).deep.equals([40, 40, 40, 40])
    await act(async () => {
      videos[0].dispatchEvent(new window.Event('timeupdate', { bubbles: true }))
      await pause()
    })
    await press('Close panel')
    await press('−10 seconds')
    expect(videos.map(video => video.currentTime)).deep.equals([30, 30, 30, 30])
  })
  it('continues the game and transfers audio when the first recording ends', async () => {
    count = 2
    await render()
    const videos = [...document.querySelectorAll('video')]
    await act(async () => {
      videos.forEach((video, index) => {
        Object.defineProperty(video, 'duration', {
          configurable: true,
          value: index === 0 ? 20 : 60
        })
        video.dispatchEvent(
          new window.Event('durationchange', { bubbles: true })
        )
      })
      await pause()
    })
    await press('Close panel')
    await act(async () => {
      videos[0].dispatchEvent(new window.Event('ended', { bubbles: true }))
      await pause()
    })
    expect(document.querySelector('[aria-label="Pause"]')).not.equals(null)
    expect(videos[0].muted).equals(true)
    expect(videos[1].muted).equals(false)
    await press('+10 seconds')
    expect(videos[1].currentTime).equals(30)
    await act(async () => {
      videos[1].dispatchEvent(new window.Event('ended', { bubbles: true }))
      await pause()
    })
    await press('Close panel')
    await press('Play')
    expect(videos[1].currentTime).equals(0)
  })
  it('offers retry when every native camera fails before loading', async () => {
    count = 2
    await render()
    const videos = [...document.querySelectorAll('video')]
    for (const video of videos) {
      await act(async () => {
        Object.defineProperty(video, 'error', {
          configurable: true,
          value: { code: 3, message: 'fixture' }
        })
        video.dispatchEvent(new window.Event('error', { bubbles: true }))
        await pause()
      })
    }
    expect(document.body.textContent).contains('cameras could not play')
    await press('Retry video')
    expect(document.querySelectorAll('video')).length(2)
    expect(document.body.textContent).not.contains('Retry video')
  })
  it('plays available cameras when another URL fails or is still preparing', async () => {
    mixed = true
    await render()
    const videos = [...document.querySelectorAll('video')]
    expect(videos).length(2)
    expect(videos.map(video => video.getAttribute('src'))).deep.equals([
      'https://example.test/2.mp4',
      'https://example.test/3.mp4'
    ])
    expect(document.body.textContent).not.contains('Retry video')
  })
  it('recovers unavailable and pending sources and handles a single camera', async () => {
    fail = true
    await render()
    expect(document.body.textContent).contains('Game unavailable')
    fail = false
    pending = true
    await press('Retry video')
    expect(document.body.textContent).contains('still preparing')
    pending = false
    count = 0
    await press('Retry video')
    expect(document.body.textContent).contains('No camera angles')
    count = 1
    await press('Retry video')
    expect(document.querySelectorAll('video')).length(1)
    await press('Camera Angle 0')
    expect(document.body.textContent).not.contains('Back to cameras')
    const video = document.querySelector('video')!
    await act(async () => {
      Object.defineProperty(video, 'error', {
        configurable: true,
        value: { code: 3, message: 'fixture' }
      })
      video.dispatchEvent(new window.Event('error', { bubbles: true }))
      await pause()
    })
    expect(document.body.textContent).contains('cameras could not play')
    await press('Retry video')
    expect(document.querySelectorAll('video')).length(1)
    expect(document.body.textContent).not.contains('Retry video')
  })
})
