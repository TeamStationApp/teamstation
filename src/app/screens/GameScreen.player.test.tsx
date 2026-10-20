import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asHighlightsResponse,
  asVideoSummary,
  type Playback,
  TeamStationClient
} from '../../common/api'
import { lstrings } from '../locales/strings'
import type { AnglesChange } from '../navigation/gameAngles'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameScreen } from './GameScreen'

/**
 * The videos page's picture and the full-screen player (U12): a tap opens the
 * player on that picture alone, at its moment; a highlight opens it at the
 * play; leaving puts the picture back at the moment the player reached,
 * paused. The player itself, its grid and its bar are `MultiCamView`'s and
 * `useMultiCam`'s tests; the frame and the address are `gameAngles.test.ts`.
 */
let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

const START = '2026-10-19T18:00:00.000Z'

function videoOf(
  id: string,
  startAt: string | null,
  syncOffsetSec = 0
): ReturnType<typeof asVideoSummary> {
  return asVideoSummary({
    id,
    title: `Game — ${id}`,
    numCameras: 1,
    kind: 'primary',
    status: 'ready',
    storage: 'local',
    startAt,
    syncOffsetSec,
    durationSec: 300,
    width: 1920,
    height: 1080,
    codecs: null
  })
}

const playable = (videoId: string): Playback => ({
  videoId,
  storage: 'local',
  url: `/media/${videoId}/master.m3u8`,
  expiresAt: '2026-10-19T20:00:00Z',
  durationSec: 300,
  unavailable: false
})

interface Page {
  changes: AnglesChange[]
  rerender: (
    props: Partial<React.ComponentProps<typeof GameScreen>>
  ) => Promise<void>
}

async function page(
  videos: Array<ReturnType<typeof asVideoSummary>>,
  props: Partial<React.ComponentProps<typeof GameScreen>> = {},
  options: { nonMember?: boolean; highlight?: boolean } = {}
): Promise<Page> {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => ({
    ...gameFixture,
    status: 'final',
    nonMemberView: options.nonMember === true,
    videos
  })
  client.highlights = async () =>
    asHighlightsResponse({
      withheld: null,
      droppedCount: 0,
      highlights:
        options.highlight === true
          ? [
              {
                eventId: 'e1',
                atBatIndex: 1,
                title: 'Selected single',
                startOffsetSec: 120,
                playOffsetSec: 123,
                eventType: 'single',
                isScoringPlay: true,
                stillUrl: '',
                description: 'The batter reaches first.'
              }
            ]
          : []
    })
  client.teams = async () => []
  client.gameScheduling = async () => {
    throw new Error('not a scheduler')
  }
  client.playback = async videoId => playable(videoId)
  const changes: AnglesChange[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  let current = props
  const draw = async (): Promise<void> => {
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GestureHandlerRootView>
            <GameScreen
              client={client}
              gameId="g1"
              initialTab="watch"
              onAngles={next => {
                changes.push(next)
              }}
              {...current}
            />
          </GestureHandlerRootView>
        </ThemeProvider>
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })
  }
  await draw()
  return {
    changes,
    rerender: async next => {
      current = { ...current, ...next }
      await draw()
    }
  }
}

/** The videos page's own `<video>`, inside the app's root. */
const inline = (): HTMLVideoElement =>
  document.querySelector<HTMLVideoElement>('#root video, body > div video')!

/** Gives the element a position and a play/pause it records. */
function drive(video: HTMLVideoElement, at: number): { played: () => number } {
  let time = at
  let paused = true
  let played = 0
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value
    }
  })
  Object.defineProperty(video, 'paused', {
    configurable: true,
    get: () => paused
  })
  video.play = async () => {
    played += 1
    paused = false
  }
  video.pause = () => {
    paused = true
  }
  return { played: () => played }
}

describe("the videos page's picture and the full-screen player (U12)", function () {
  it('has no controls, and a tap opens the player on it alone, at its moment', async function () {
    const view = await page([videoOf('v1', START, 2), videoOf('v2', START)])
    const video = inline()
    expect(video.controls).equals(false)
    drive(video, 41.5)
    const open = document.querySelector<HTMLElement>(
      '[data-testid="gameVideoOpen"]'
    )!
    expect(open.getAttribute('aria-label')).equals(lstrings.game_video_open)
    await act(async () => {
      open.click()
    })
    expect(view.changes.at(-1)).deep.equals({
      angles: ['v1'],
      audio: 'v1',
      zoom: null,
      at: null,
      from: { videoId: 'v1', sec: 41.5 }
    })
  })

  it('opens the player at a highlight, with the picture moved there too', async function () {
    const view = await page([videoOf('v1', START)], {}, { highlight: true })
    const video = inline()
    drive(video, 0)
    const highlight = document.querySelector<HTMLElement>(
      '[aria-label="Play highlight: Selected single"]'
    )!
    await act(async () => {
      highlight.click()
    })
    expect(view.changes.at(-1)?.from).deep.equals({ videoId: 'v1', sec: 120 })
    expect(view.changes.at(-1)?.angles).deep.equals(['v1'])
    expect(video.currentTime).equals(120)
  })

  it('puts the picture back at the moment the player reached, paused', async function () {
    // Two seconds of sync offset: the player opens on the picture's own wall
    // time, and the way back converts it through the same offset.
    const from = { videoId: 'v1', sec: 40 }
    const view = await page([videoOf('v1', START, 2)], {
      angles: ['v1'],
      audioId: 'v1',
      from
    })
    const video = inline()
    const { played } = drive(video, 40)
    const close = document.querySelector<HTMLElement>(
      `[aria-label="${lstrings.angles_close}"]`
    )!
    await act(async () => {
      close.click()
    })
    expect(view.changes.at(-1)).deep.equals({
      angles: [],
      audio: null,
      zoom: null,
      at: null,
      from: null
    })
    video.currentTime = 0
    await view.rerender({
      angles: undefined,
      audioId: undefined,
      from: undefined
    })
    await act(async () => {
      video.dispatchEvent(new window.Event('loadedmetadata'))
    })
    expect(video.currentTime).closeTo(40, 0.001)
    expect(video.paused).equals(true)
    expect(played()).equals(0)
  })

  it('opens a lone recording with no start on its own media time, and back', async function () {
    const view = await page([videoOf('u1', null)])
    drive(inline(), 25)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="gameVideoOpen"]')!
        .click()
    })
    const opened = view.changes.at(-1)!
    expect(opened.from).deep.equals({ videoId: 'u1', sec: 25 })
    await view.rerender({ angles: ['u1'], audioId: 'u1', from: opened.from! })
    // Its tile is placeable: it is on its media time, not "no start".
    expect(document.body.textContent).not.includes(lstrings.angles_unplaceable)
    const video = inline()
    drive(video, 25)
    await act(async () => {
      document
        .querySelector<HTMLElement>(`[aria-label="${lstrings.angles_close}"]`)!
        .click()
    })
    video.currentTime = 0
    await view.rerender({
      angles: undefined,
      audioId: undefined,
      from: undefined
    })
    await act(async () => {
      video.dispatchEvent(new window.Event('loadedmetadata'))
    })
    expect(video.currentTime).closeTo(25, 0.001)
  })

  it('keeps a non-member to the poster and the warning', async function () {
    await page([videoOf('v1', START)], {}, { nonMember: true })
    expect(document.querySelector('[data-testid="gameVideoOpen"]')).equals(null)
    expect(document.querySelector('video')).equals(null)
  })
})
