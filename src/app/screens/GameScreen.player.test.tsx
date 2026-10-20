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
import { wallTimelineOf } from '../../test/overlayFixtures'
import { lstrings } from '../locales/strings'
import type { AnglesChange } from '../navigation/gameAngles'
import { HAVE_METADATA } from '../player/videoHandle'
import { MAPPING_WAIT_MS } from '../player/wallMapping'
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
  options: {
    nonMember?: boolean
    highlight?: boolean
    timeline?: Array<[number, number]>
    /** Each video's own wall timeline, by id. */
    timelines?: Record<string, Array<[number, number]>>
  } = {}
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
  client.wallTimeline = async videoId => {
    const anchors = options.timelines?.[videoId] ?? options.timeline
    if (anchors == null) throw new Error('no timeline')
    return wallTimelineOf(anchors)
  }
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

/**
 * A resume waits for the stream to say whether it has dates, then for the
 * server's timeline, two seconds each, before its start places it: the
 * page's player in a test page says nothing.
 */
const LANDING_MS = 4300
const waitToLand = async (): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, LANDING_MS))
  })
}

/** Gives the element a position and a play/pause it records. */
function drive(
  video: HTMLVideoElement,
  at: number,
  seekableTo?: { end: number }
): { played: () => number } {
  let time = at
  let paused = true
  let played = 0
  if (seekableTo != null)
    Object.defineProperty(video, 'seekable', {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => seekableTo.end })
    })
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
  this.timeout(15_000)

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
    // Placed by its start and its two seconds of sync offset.
    expect(view.changes.at(-1)).deep.equals({
      angles: ['v1'],
      audio: 'v1',
      zoom: null,
      at: null,
      from: {
        videoId: 'v1',
        sec: 41.5,
        wallMs: Date.parse(START) + 39_500
      }
    })
  })

  it('plays the picture silent, the player with its sound, and the picture silent again once it closes', async function () {
    const view = await page([videoOf('v1', START)])
    expect(inline().muted).equals(true)
    drive(inline(), 20)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="gameVideoOpen"]')!
        .click()
    })
    const opened = view.changes.at(-1)!
    expect(opened.audio).equals('v1')
    await view.rerender({ angles: ['v1'], audioId: 'v1', from: opened.from! })
    const tile = [...document.querySelectorAll('video')].at(-1)!
    expect(tile.muted).equals(false)
    await act(async () => {
      document
        .querySelector<HTMLElement>(`[aria-label="${lstrings.angles_close}"]`)!
        .click()
    })
    await view.rerender({
      angles: undefined,
      audioId: undefined,
      from: undefined
    })
    expect(document.querySelectorAll('video')).length(1)
    expect(inline().muted).equals(true)
  })

  it('opens at the wall time the picture’s own timeline gives, across a 34 s discontinuity (M8)', async function () {
    const start = Date.parse(START)
    // Ten seconds, then the wall clock jumps 34 s on.
    const view = await page(
      [videoOf('v1', START)],
      {},
      {
        timeline: [
          [0, start],
          [10_000, start + 44_000]
        ]
      }
    )
    drive(inline(), 20)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="gameVideoOpen"]')!
        .click()
    })
    expect(view.changes.at(-1)?.from).deep.equals({
      videoId: 'v1',
      sec: 20,
      wallMs: start + 54_000
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
    expect(view.changes.at(-1)?.from).deep.include({ videoId: 'v1', sec: 120 })
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
    await waitToLand()
    expect(video.currentTime).closeTo(40, 0.001)
    expect(video.paused).equals(true)
    expect(played()).equals(0)
  })

  it('keeps the ✕’s own moment, not one the grid reaches as it goes', async function () {
    const from = { videoId: 'v1', sec: 40 }
    const view = await page([videoOf('v1', START)], {
      angles: ['v1'],
      audioId: 'v1',
      from
    })
    const video = inline()
    drive(video, 40)
    const pictures = [...document.querySelectorAll('video')]
    expect(pictures).length(2)
    const tile = pictures[1]
    drive(tile, 40)
    await act(async () => {
      document
        .querySelector<HTMLElement>(`[aria-label="${lstrings.angles_close}"]`)!
        .click()
    })
    // The tile plays on between the tap and the grid going.
    drive(tile, 55)
    Object.defineProperty(tile, 'paused', { configurable: true, value: false })
    video.currentTime = 0
    await view.rerender({
      angles: undefined,
      audioId: undefined,
      from: undefined
    })
    await act(async () => {
      video.dispatchEvent(new window.Event('loadedmetadata'))
    })
    await waitToLand()
    expect(video.currentTime).closeTo(40, 0.001)
  })

  it('puts the picture back at the player’s moment, paused, when Back takes the player away', async function () {
    const from = { videoId: 'v1', sec: 40 }
    const view = await page([videoOf('v1', START)], {
      angles: ['v1'],
      audioId: 'v1',
      from
    })
    const video = inline()
    const { played } = drive(video, 0)
    // The address loses its angles, with no close: the browser's Back.
    await view.rerender({
      angles: undefined,
      audioId: undefined,
      from: undefined
    })
    await act(async () => {
      video.dispatchEvent(new window.Event('loadedmetadata'))
    })
    await waitToLand()
    expect(video.currentTime).closeTo(40, 0.001)
    expect(video.paused).equals(true)
    expect(played()).equals(0)
  })

  it('lands at once when the timeline has answered with no anchors and the stream with no dates', async function () {
    // Safari's own player, which says at once whether a stream has dates.
    const canPlay = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      'canPlayType'
    )!
    const play = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      'play'
    )!
    Object.defineProperty(window.HTMLMediaElement.prototype, 'canPlayType', {
      configurable: true,
      value: () => 'maybe'
    })
    Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: async () => undefined
    })
    try {
      const from = { videoId: 'v1', sec: 40 }
      const view = await page(
        [videoOf('v1', START)],
        { angles: ['v1'], audioId: 'v1', from },
        { timeline: [] }
      )
      const video = inline()
      drive(video, 0)
      const attached = Date.now()
      await view.rerender({
        angles: undefined,
        audioId: undefined,
        from: undefined
      })
      // The timeline answers, with no anchors.
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 300))
      })
      // Loaded, with no start date: the stream says it carries none.
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HAVE_METADATA
      })
      await act(async () => {
        video.dispatchEvent(new window.Event('loadedmetadata'))
      })
      expect(video.currentTime).closeTo(40, 0.001)
      expect(Date.now() - attached).lessThan(MAPPING_WAIT_MS)
    } finally {
      Object.defineProperty(
        window.HTMLMediaElement.prototype,
        'canPlayType',
        canPlay
      )
      Object.defineProperty(window.HTMLMediaElement.prototype, 'play', play)
    }
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
    // On its own media time.
    expect(opened.from).deep.equals({ videoId: 'u1', sec: 25, wallMs: 25_000 })
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
    await waitToLand()
    expect(video.currentTime).closeTo(25, 0.001)
  })

  it('keeps a non-member to the poster and the warning', async function () {
    await page([videoOf('v1', START)], {}, { nonMember: true })
    expect(document.querySelector('[data-testid="gameVideoOpen"]')).equals(null)
    expect(document.querySelector('video')).equals(null)
  })
})

describe('another angle, at the same moment (U23)', function () {
  this.timeout(20_000)

  /** Picks the angle at `index` from the strip above the picture. */
  async function pick(index: number): Promise<void> {
    const tab = document.querySelectorAll<HTMLElement>(
      '[aria-label="Camera angles"] [role="tab"]'
    )[index]
    if (tab == null) throw new Error(`no angle ${index}`)
    await act(async () => {
      tab.click()
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })
  }

  it('lands where the new angle’s own timeline puts the moment, once it can be sought to', async function () {
    const start = Date.parse(START)
    // v2's pictures begin thirty seconds after its start says.
    await page(
      [videoOf('v1', START), videoOf('v2', START)],
      {},
      {
        timelines: { v2: [[0, start + 30_000]] }
      }
    )
    const video = inline()
    drive(video, 100)
    video.play = async () => undefined
    await pick(1)
    // The new source: not yet seekable past fifty seconds.
    const seekable = { end: 50 }
    const { played } = drive(video, 0, seekable)
    await act(async () => {
      video.dispatchEvent(new window.Event('loadedmetadata'))
    })
    await waitToLand()
    expect(video.currentTime, 'held until it is seekable').equals(0)
    seekable.end = 120
    await act(async () => {
      video.dispatchEvent(new window.Event('progress'))
    })
    expect(video.currentTime).closeTo(70, 0.001)
    expect(played()).equals(0)
  })

  it('lands on the last picture of a recording shorter than the moment, rather than waiting', async function () {
    // v2's row says ten minutes; its file holds five.
    await page(
      [
        { ...videoOf('v1', START), durationSec: 900 },
        { ...videoOf('v2', START), durationSec: 600 }
      ],
      {}
    )
    const video = inline()
    drive(video, 400)
    video.play = async () => undefined
    await pick(1)
    // The file ends at 300 s and can be sought to its end.
    const { played } = drive(video, 0, { end: 300 })
    Object.defineProperty(video, 'duration', {
      configurable: true,
      get: () => 300
    })
    await act(async () => {
      video.dispatchEvent(new window.Event('loadedmetadata'))
    })
    await waitToLand()
    expect(video.currentTime).closeTo(300, 0.001)
    expect(played()).equals(0)
  })

  it('copies the position, kept inside, to or from a recording with no start', async function () {
    await page([videoOf('v1', START), videoOf('u1', null)])
    const video = inline()
    drive(video, 100)
    await pick(1)
    drive(video, 0)
    await act(async () => {
      video.dispatchEvent(new window.Event('loadedmetadata'))
    })
    expect(video.currentTime).equals(100)
  })
})
