import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asVideoGame, type TeamStationClient } from '../../common/api'
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
          status: 'ready'
        })),
        { id: 'mosaic', title: 'Mosaic', numCameras: 4, status: 'ready' },
        { id: 'processing', numCameras: 1, status: 'processing' }
      ]
    }
  },
  playback: async (id: string) => ({
    url: pending ? null : `https://example.test/${id}.mp4`
  })
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
  fail = false
  pending = false
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
    expect(document.body.textContent).contains('camera could not play')
  })
})
