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
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameScreen } from './GameScreen'

/**
 * A live video is listed as soon as its stream starts publishing, before its
 * first segment exists, and the server answers that its files are not there.
 * The game page asks again while the video is live, so it plays once the
 * segment lands instead of saying for good that it is not available.
 */
let root: Root | undefined

const UNAVAILABLE = 'This video is not available right now.'

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const text = (): string => document.body.textContent ?? ''

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

function videoOf(status: string): ReturnType<typeof asVideoSummary> {
  return asVideoSummary({
    id: 'v1',
    title: 'Game — Home Plate',
    numCameras: 1,
    kind: 'live',
    status,
    storage: 'local',
    startAt: '2026-05-02T18:30:00Z',
    durationSec: null,
    width: null,
    height: null,
    codecs: null
  })
}

const missing: Playback = {
  videoId: 'v1',
  storage: 'local',
  url: null,
  expiresAt: null,
  durationSec: null,
  unavailable: true
}

const there: Playback = {
  ...missing,
  url: '/media/v1/master.m3u8',
  expiresAt: '2026-05-02T19:30:00Z',
  unavailable: false
}

/** The game page on a game whose one video has `status`. */
async function page(
  status: string,
  answers: Array<Playback | Error>
): Promise<{ asked: () => number }> {
  let asked = 0
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => ({
    ...gameFixture,
    status: 'inProgress',
    videos: [videoOf(status)]
  })
  client.highlights = async () =>
    asHighlightsResponse({ withheld: null, droppedCount: 0, highlights: [] })
  client.teams = async () => []
  client.gameScheduling = async () => {
    throw new Error('not a scheduler')
  }
  client.playback = async () => {
    const answer = answers[Math.min(asked, answers.length - 1)]
    asked += 1
    if (answer instanceof Error) throw answer
    return answer
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GestureHandlerRootView>
          <GameScreen client={client} gameId="g1" initialTab="watch" />
        </GestureHandlerRootView>
      </ThemeProvider>
    )
  })
  await act(async () => {
    await delay(20)
  })
  return { asked: () => asked }
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await delay(ms)
  })
}

/** Waits for `done`, for as long as a loaded machine might need. */
async function until(done: () => boolean, ms = 10000): Promise<void> {
  for (const end = Date.now() + ms; !done();) {
    expect(Date.now() < end, 'in time').equals(true)
    await wait(100)
  }
}

describe('a live video whose first segment is not written yet', function () {
  this.timeout(30000)

  it('plays once its files are there, asking again meanwhile', async function () {
    const { asked } = await page('live', [missing, missing, there])
    expect(text()).includes(UNAVAILABLE)
    expect(document.querySelector('video')).equals(null)
    await until(() => asked() === 2)
    expect(text()).includes(UNAVAILABLE)
    await until(() => asked() === 3)
    await until(() => !text().includes(UNAVAILABLE))
    expect(document.querySelector('video')).not.equals(null)
    // Playing: nothing more to ask.
    await wait(2200)
    expect(asked()).equals(3)
  })

  it('asks again after a failed ask', async function () {
    const { asked } = await page('live', [missing, new Error('offline'), there])
    await until(() => document.querySelector('video') != null)
    expect(asked()).equals(3)
  })

  it('leaves a recorded video without files alone', async function () {
    const { asked } = await page('ready', [missing, there])
    expect(text()).includes(UNAVAILABLE)
    await wait(2200)
    expect(asked()).equals(1)
    expect(text()).includes(UNAVAILABLE)
  })
})
