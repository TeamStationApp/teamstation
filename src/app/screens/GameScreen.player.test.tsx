import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'
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
    /** Each video's playback, when not at once. */
    playback?: (videoId: string) => Promise<Playback>
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
                endOffsetSec: 128,
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
  client.playback = options.playback ?? (async videoId => playable(videoId))
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

  // A highlight opens the full-screen player in the app only: these tests
  // run in a browser build, so the app's cases say they are the app.
  let platformWas: typeof Platform.OS | null = null
  const asApp = (): void => {
    platformWas ??= Platform.OS
    Platform.OS = 'ios'
  }
  afterEach(function () {
    if (platformWas != null) Platform.OS = platformWas
    platformWas = null
  })

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
      },
      highlightUntil: null
    })
  })

  it('keeps the picture silent until its own sound square, and heard after (U15)', async function () {
    await page([videoOf('v1', START)])
    expect(inline().muted).equals(true)
    const zones = document.querySelector('[data-testid="gameVideoZones"]')!
    const tap = async (x: number, y: number): Promise<void> => {
      for (const type of ['mousedown', 'mouseup'])
        await act(async () => {
          zones.dispatchEvent(
            new window.MouseEvent(type, {
              bubbles: true,
              clientX: x,
              clientY: y,
              button: 0,
              buttons: type === 'mouseup' ? 0 : 1
            })
          )
        })
    }
    // The top-left square, near its corner.
    await tap(3, 3)
    expect(inline().muted).equals(false)
    await tap(3, 3)
    expect(inline().muted).equals(true)
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

  it('uncovers the picture a few seconds on even when its resume cannot land', async function () {
    this.timeout(12_000)
    const view = await page([videoOf('v1', START)], {
      angles: ['v1'],
      audioId: 'v1',
      from: { videoId: 'v1', sec: 40 }
    })
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
    const landing = (): Element | null =>
      document.querySelector('[data-testid="gameVideoLanding"]')
    // The picture never says it has loaded, nor that a seek is done.
    expect(landing()).not.equals(null)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 6200))
    })
    expect(landing()).equals(null)
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

  it('in a browser, plays a highlight in the picture, with its sound, without opening the player', async function () {
    const view = await page([videoOf('v1', START)], {}, { highlight: true })
    const video = inline()
    const { played } = drive(video, 0)
    // Silent until something turns the sound on, as the page starts it.
    expect(video.muted).equals(true)
    const highlight = document.querySelector<HTMLElement>(
      '[aria-label="Play highlight: Selected single"]'
    )!
    await act(async () => {
      highlight.click()
    })
    expect(view.changes.filter(change => change.from != null)).length(0)
    expect(video.currentTime).equals(120)
    expect(played()).greaterThan(0)
    // Heard, as the full-screen player it replaces was, from the tap itself.
    expect(video.muted).equals(false)
  })

  it('in a browser, plays a highlight chosen on another page with its sound, or silent if the browser refuses it', async function () {
    // Its start (0 s takes the page's plain autoplay rather than a link's
    // jump), and how the first `play()` with sound is answered.
    for (const [at, answer] of [
      [120, null],
      [120, 'NotAllowedError'],
      [120, 'AbortError'],
      [0, 'NotAllowedError']
    ] as const) {
      const label = `${at} s, ${answer ?? 'allowed'}`
      await page([videoOf('v1', START)], {
        initialVideoId: 'v1',
        startAtSec: at,
        autoPlay: true,
        highlightUntil: at + 8
      })
      const video = inline()
      drive(video, 0)
      let tries = 0
      video.play = async () => {
        tries += 1
        if (answer != null && !video.muted) {
          const error = new Error('not played')
          error.name = answer
          throw error
        }
      }
      expect(video.muted, `${label}: heard from the start`).equals(false)
      await act(async () => {
        video.dispatchEvent(new window.Event('loadedmetadata'))
      })
      expect(video.currentTime, label).equals(at)
      // Refused with its sound, it plays silent rather than not at all. An
      // interrupted play is no refusal: the sound stays, and it is not
      // played again behind whatever interrupted it.
      const refused = answer === 'NotAllowedError'
      expect(video.muted, label).equals(refused)
      expect(tries, label).equals(refused ? 2 : 1)
      await act(async () => {
        root?.unmount()
      })
    }
  })

  it('in a browser, keeps to a highlight chosen before a linked moment has loaded', async function () {
    await page(
      [videoOf('v1', START)],
      { startAtSec: 30, autoPlay: true },
      { highlight: true }
    )
    const video = inline()
    drive(video, 0)
    const highlight = document.querySelector<HTMLElement>(
      '[aria-label="Play highlight: Selected single"]'
    )!
    await act(async () => {
      highlight.click()
    })
    expect(video.currentTime).equals(120)
    // The link's moment, still waiting for the metadata, gives way to it.
    await act(async () => {
      video.dispatchEvent(new window.Event('loadedmetadata'))
    })
    expect(video.currentTime).equals(120)
  })

  it('in a browser, plays a highlight chosen on another page in the picture, and drops it', async function () {
    const view = await page([videoOf('v1', START)], {
      initialVideoId: 'v1',
      startAtSec: 120,
      autoPlay: true,
      highlightUntil: 128
    })
    // The picture starts at the highlight and plays, once it can.
    const video = inline()
    const { played } = drive(video, 0)
    await act(async () => {
      video.dispatchEvent(new window.Event('loadedmetadata'))
    })
    expect(video.currentTime).equals(120)
    expect(played()).greaterThan(0)
    expect(view.changes.filter(change => change.from != null)).length(0)
    expect(view.changes).deep.includes({ highlightUntil: null })
  })

  it('in the app, opens the player at a highlight, with the picture moved there too', async function () {
    asApp()
    const view = await page([videoOf('v1', START)], {}, { highlight: true })
    const video = inline()
    drive(video, 0)
    const highlight = document.querySelector<HTMLElement>(
      '[aria-label="Play highlight: Selected single"]'
    )!
    await act(async () => {
      highlight.click()
    })
    expect(view.changes.at(-1)?.from).deep.include({
      videoId: 'v1',
      sec: 120,
      untilSec: 128
    })
    // The end's wall time on the start's own mapping: eight seconds on.
    const from = view.changes.at(-1)!.from!
    expect(from.untilWallMs! - from.wallMs!).equals(8000)
    expect(view.changes.at(-1)?.highlightUntil).equals(null)
    expect(view.changes.at(-1)?.angles).deep.equals(['v1'])
    expect(video.currentTime).equals(120)
  })

  it('in the app, opens a highlight only on the video it was chosen on', async function () {
    asApp()
    // v1, the highlight's, never becomes playable; v2 does at once.
    const view = await page(
      [videoOf('v1', START), videoOf('v2', START)],
      {
        initialVideoId: 'v1',
        startAtSec: 120,
        autoPlay: true,
        highlightUntil: 128
      },
      {
        playback: async videoId =>
          videoId === 'v1'
            ? await new Promise<Playback>(() => undefined)
            : playable(videoId)
      }
    )
    expect(view.changes.filter(change => change.from != null)).length(0)
    // Another camera, chosen before the highlight could open: not opened on it.
    const tab = document.querySelectorAll<HTMLElement>(
      '[aria-label="Camera angles"] [role="tab"]'
    )[1]
    await act(async () => {
      tab.click()
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(view.changes.filter(change => change.from != null)).length(0)
    // And the highlight is dropped, so it does not wait for a way back to v1.
    expect(view.changes).deep.includes({ highlightUntil: null })
  })

  it('in the app, keeps a highlight waiting through a video the page chose itself', async function () {
    asApp()
    // A copy of the game that does not list the highlight's recording yet:
    // the page paints the one it has.
    const view = await page([videoOf('v2', START)], {
      initialVideoId: 'v1',
      startAtSec: 120,
      autoPlay: true,
      highlightUntil: 128
    })
    expect(view.changes.filter(change => change.from != null)).length(0)
    expect(view.changes).not.deep.includes({ highlightUntil: null })
  })

  it('in the app, opens a highlight chosen on another page straight into the player, once', async function () {
    asApp()
    const view = await page([videoOf('v1', START)], {
      initialVideoId: 'v1',
      startAtSec: 120,
      autoPlay: true,
      highlightUntil: 128
    })
    const opens = view.changes.filter(change => change.from != null)
    expect(opens).length(1)
    expect(opens[0].from).deep.include({
      videoId: 'v1',
      sec: 120,
      untilSec: 128
    })
    expect(opens[0].highlightUntil).equals(null)
    // Drawn again with the highlight taken off, as the shell does: nothing
    // more opens.
    await view.rerender({ highlightUntil: undefined })
    expect(view.changes.filter(change => change.from != null)).length(1)
  })

  for (const playing of [true, false])
    it(`puts the picture back at the moment the player reached, ${playing ? 'playing' : 'paused'} as the player was`, async function () {
      // Two seconds of sync offset: the player opens on the picture's own
      // wall time, and the way back converts it through the same offset.
      const from = { videoId: 'v1', sec: 40 }
      const view = await page([videoOf('v1', START, 2)], {
        angles: ['v1'],
        audioId: 'v1',
        from
      })
      const video = inline()
      const { played } = drive(video, 40)
      if (!playing)
        // The grid's own pause, from its keyboard.
        await act(async () => {
          window.dispatchEvent(
            new window.KeyboardEvent('keydown', { key: 'k', bubbles: true })
          )
        })
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
      // Covered while it is on its way back: frame 0 is not that moment.
      const landing = (): Element | null =>
        document.querySelector('[data-testid="gameVideoLanding"]')
      expect(landing()).not.equals(null)
      await act(async () => {
        video.dispatchEvent(new window.Event('loadedmetadata'))
      })
      // Loaded, as a player is once it has said so, and seeking to the
      // resume's moment until it says the seek is done.
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: 1
      })
      let seeking = true
      Object.defineProperty(video, 'seeking', {
        configurable: true,
        get: () => seeking
      })
      await waitToLand()
      // Until the player has drawn the frame there, which it says: with a
      // `seeked`, or as the phone's can, with its next time and no seek in
      // flight.
      expect(landing()).not.equals(null)
      await act(async () => {
        video.dispatchEvent(new window.Event('timeupdate'))
      })
      expect(landing(), 'a time with the seek still in flight').not.equals(null)
      await act(async () => {
        seeking = false
        video.dispatchEvent(new window.Event(playing ? 'seeked' : 'timeupdate'))
      })
      expect(landing()).equals(null)
      expect(video.currentTime).closeTo(40, 0.001)
      expect(video.paused).equals(!playing)
      expect(played() > 0).equals(playing)
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

  it('puts the picture back at the player’s moment, playing as the player was, when Back takes the player away', async function () {
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
    expect(video.paused).equals(false)
    expect(played()).greaterThan(0)
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

describe('a browser that cannot play the video (U32)', function () {
  let mediaSource: PropertyDescriptor | undefined
  beforeEach(function () {
    mediaSource = Object.getOwnPropertyDescriptor(globalThis, 'MediaSource')
    // No HEVC through Media Source, and no HLS of its own.
    Object.defineProperty(globalThis, 'MediaSource', {
      configurable: true,
      value: { isTypeSupported: () => false }
    })
  })
  afterEach(async function () {
    // The grid is portalled into the body: React takes it out first.
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    if (mediaSource == null) Reflect.deleteProperty(globalThis, 'MediaSource')
    else Object.defineProperty(globalThis, 'MediaSource', mediaSource)
  })

  it('says so in place of the picture, with nothing to open', async function () {
    const view = await page([videoOf('v1', START)], {}, { highlight: true })
    expect(document.body.textContent).includes(lstrings.video_not_supported)
    expect(document.querySelector('#root video, body > div video')).equals(null)
    expect(document.querySelector('[data-testid="gameVideoOpen"]')).equals(null)
    // Nor does a highlight open the player on it.
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[aria-label="Play highlight: Selected single"]'
        )!
        .click()
    })
    expect(view.changes.some(change => change.from != null)).equals(false)
  })

  it('says so on every tile of All Angles, attaching nothing', async function () {
    await page([videoOf('v1', START), videoOf('v2', START)], {
      angles: ['v1', 'v2'],
      audioId: 'v1'
    })
    const states = [...document.querySelectorAll('[data-tile-state]')].map(
      tile => tile.getAttribute('data-tile-state')
    )
    expect(states).deep.equals(['unsupported', 'unsupported'])
    const said = [...document.querySelectorAll('div')].filter(
      node => node.textContent === lstrings.video_not_supported
    )
    expect(said.length).at.least(2)
    for (const video of document.querySelectorAll('video'))
      expect(video.getAttribute('src')).equals(null)
  })
})
