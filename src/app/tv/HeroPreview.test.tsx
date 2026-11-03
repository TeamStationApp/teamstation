import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asVideoSummary,
  type TeamStationClient,
  type VideoSummary
} from '../../common/api'
import { HeroPreview, previewCandidates } from './HeroPreview'

let root: Root | undefined
const video = (id: string, title = id, status = 'ready'): VideoSummary =>
  asVideoSummary({
    id,
    title,
    status,
    kind: 'program',
    storage: 'local',
    startAt: null,
    durationSec: 90,
    width: 640,
    height: 360,
    codecs: null
  })
const tick = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 25))
}
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible'
  })
})
describe('TV hero preview', () => {
  it('ranks whole camera names and excludes unavailable and empty recordings', () => {
    expect(
      previewCandidates([
        video('x'),
        video('h', 'HOME Plate'),
        video('p', 'Primary angle'),
        video('bad', 'Primary', 'error'),
        { ...video('empty'), durationSec: 0 },
        { ...video('multi'), numCameras: 4 }
      ]).map(v => v.id)
    ).deep.equals(['p', 'h', 'x'])
  })
  it('falls back through rejected and missing URLs, plays at sixty percent and stops off page/background', async () => {
    const calls: string[] = []
    const client = {
      game: async () => ({
        videos: [video('p', 'Primary'), video('h', 'Home'), video('f')]
      }),
      playback: async (id: string) => {
        calls.push(id)
        if (id === 'p') throw Error('offline')
        return { url: id === 'h' ? null : 'https://example.test/fixture.mp4' }
      }
    } as unknown as TeamStationClient
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<HeroPreview client={client} gameId="game" active />)
      await tick()
    })
    await act(tick)
    expect(calls).deep.equals(['p', 'h', 'f'])
    const media = document.querySelector('video')!
    expect(media).not.equals(null)
    expect(media.volume).equals(0.6)
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden'
      })
      document.dispatchEvent(new window.Event('visibilitychange'))
      await tick()
    })
    expect(document.querySelector('video')).equals(null)
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible'
      })
      document.dispatchEvent(new window.Event('visibilitychange'))
      await tick()
    })
    await act(tick)
    expect(document.querySelector('video')).not.equals(null)
    await act(async () => {
      Object.defineProperty(document.querySelector('video')!, 'error', {
        configurable: true,
        value: { code: 3, message: 'decode failed' }
      })
      document.querySelector('video')!.dispatchEvent(new window.Event('error'))
      await tick()
    })
    await act(tick)
    expect(document.querySelector('video')).equals(null)
    await act(async () => {
      root!.render(<HeroPreview client={client} gameId="game" active={false} />)
      await tick()
    })
    expect(document.querySelector('video')).equals(null)
  })
  it('ignores a URL resolved after leaving and preserves the poster on discovery failure', async () => {
    let finish!: (value: { url: string }) => void
    const client = {
      game: async () => ({ videos: [video('a')] }),
      playback: async () =>
        await new Promise(resolve => {
          finish = resolve
        })
    } as unknown as TeamStationClient
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<HeroPreview client={client} gameId="g" active />)
      await tick()
    })
    await act(tick)
    await act(async () => {
      root!.render(<HeroPreview client={client} gameId="g" active={false} />)
      await tick()
    })
    await act(async () => {
      finish({ url: 'https://example.test/late.mp4' })
      await tick()
    })
    expect(document.querySelector('video')).equals(null)
    const failing = {
      game: async () => {
        throw Error('offline')
      }
    } as unknown as TeamStationClient
    await act(async () => {
      root!.render(<HeroPreview client={failing} gameId="other" active />)
      await tick()
    })
    await act(tick)
    expect(document.querySelector('video')).equals(null)
  })
})
