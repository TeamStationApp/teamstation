import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asHighlightsResponse,
  asVideoSummary,
  type Playback,
  TeamStationClient,
  type VideoSummary
} from '../../common/api'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameScreen } from './GameScreen'

/**
 * A page left open on a live video takes that video's fresh entry each time
 * the game's list is asked for again: the camera ending takes its LIVE pill
 * away, and a start the phone corrected is the one an angle switch maps the
 * position through.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

function videoOf(
  id: string,
  title: string,
  status: string,
  startAt: string
): VideoSummary {
  return asVideoSummary({
    id,
    title,
    numCameras: 1,
    kind: 'live',
    status,
    storage: 'local',
    startAt,
    durationSec: null,
    width: null,
    height: null,
    codecs: null
  })
}

const playback = (videoId: string): Playback => ({
  videoId,
  storage: 'local',
  url: `/media/${videoId}/master.m3u8`,
  expiresAt: '2026-05-02T19:30:00Z',
  durationSec: null,
  unavailable: false
})

/**
 * The game page on a game whose videos are `before` until the test calls
 * `change`, and `after` from then on.
 */
async function page(
  before: VideoSummary[],
  after: VideoSummary[],
  onMoment?: (videoId: string, atSec: number) => void
): Promise<{
  change: () => void
  readsAfter: () => number
  playbackAsks: () => number
}> {
  let changed = false
  let readsAfter = 0
  let playbackAsks = 0
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => {
    if (changed) readsAfter += 1
    const videos = changed ? after : before
    return { ...gameFixture, status: 'inProgress', videos }
  }
  client.highlights = async () =>
    asHighlightsResponse({ withheld: null, droppedCount: 0, highlights: [] })
  client.teams = async () => []
  client.gameScheduling = async () => {
    throw new Error('not a scheduler')
  }
  client.playback = async videoId => {
    playbackAsks += 1
    return playback(videoId)
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GestureHandlerRootView>
          <GameScreen
            client={client}
            gameId="g1"
            initialTab="watch"
            onMoment={onMoment}
          />
        </GestureHandlerRootView>
      </ThemeProvider>
    )
  })
  await wait(20)
  return {
    change: () => {
      changed = true
    },
    readsAfter: () => readsAfter,
    playbackAsks: () => playbackAsks
  }
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await delay(ms)
  })
}

/** Waits for `done`, past one refresh of the list on a loaded machine. */
async function until(done: () => boolean, ms = 20000): Promise<void> {
  for (const end = Date.now() + ms; !done();) {
    expect(Date.now() < end, 'in time').equals(true)
    await wait(100)
  }
}

const livePill = (): Element | null =>
  document.querySelector('[aria-label="Live now"]')

describe('the video a game page is playing, as its list refreshes', function () {
  this.timeout(40000)

  it('stops reading as live once the camera ends', async function () {
    const START = '2026-05-02T18:30:00Z'
    const { change, readsAfter, playbackAsks } = await page(
      [videoOf('v1', 'Game — Home Plate', 'live', START)],
      [videoOf('v1', 'Game — Home Plate', 'ready', START)]
    )
    await until(() => document.querySelector('video') != null)
    expect(livePill()).not.equals(null)
    change()
    await until(() => readsAfter() >= 1)
    await wait(100)
    expect(livePill()).equals(null)
    // The same video, so it goes on playing rather than starting again.
    expect(playbackAsks()).equals(1)
    expect(document.querySelector('video')).not.equals(null)
  })

  it('switches angle from the start the phone corrected', async function () {
    const moments: Array<[string, number]> = []
    const second = videoOf(
      'v2',
      'Game — First Base',
      'live',
      '2026-05-02T18:29:00Z'
    )
    const { change, readsAfter } = await page(
      [
        videoOf('v1', 'Game — Home Plate', 'live', '2026-05-02T18:30:00Z'),
        second
      ],
      [
        videoOf('v1', 'Game — Home Plate', 'live', '2026-05-02T18:30:30Z'),
        second
      ],
      (videoId, atSec) => moments.push([videoId, atSec])
    )
    await until(() => document.querySelector('video') != null)
    change()
    await until(() => readsAfter() >= 1)
    await wait(100)
    const tab = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].find(node => (node.textContent ?? '').includes('First Base'))
    expect(tab, 'First Base tab').not.equals(undefined)
    await act(async () => {
      tab!.click()
    })
    await wait(50)
    // At the start of Home Plate, which began 18:30:30, First Base (from
    // 18:29:00) is 90 s in. The start the page first saw would say 60.
    expect(moments).deep.equals([['v2', 90]])
  })
})
