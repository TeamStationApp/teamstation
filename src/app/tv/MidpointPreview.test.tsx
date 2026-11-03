import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { MidpointPreview, previewMidpoint } from './MidpointPreview'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
})
describe('TV midpoint previews', () => {
  it('requires a finite VOD duration or both absolute live DVR bounds', () => {
    expect(previewMidpoint(60, false)).equals(30)
    for (const duration of [0, -1, Infinity, NaN])
      expect(previewMidpoint(duration, false)).equals(null)
    expect(previewMidpoint(60, true)).equals(null)
    expect(previewMidpoint(Infinity, true, { start: 100, end: 160 })).equals(
      130
    )
    for (const range of [
      { start: -1, end: 20 },
      { start: NaN, end: 20 },
      { start: 1, end: Infinity },
      { start: 30, end: 30 },
      { start: 30, end: 20 }
    ])
      expect(previewMidpoint(60, true, range)).equals(null)
  })
  it('seeks before revealing, loops from halfway and keeps focused previews muted', async () => {
    let errors = 0
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <MidpointPreview
          uri="https://example.test/preview.mp4"
          live={false}
          muted
          testID="preview"
          onError={() => {
            errors++
          }}
        />
      )
    })
    const media = document.querySelector('video')!
    expect(media.muted).equals(true)
    expect(media.loop).equals(false)
    await act(async () => {
      media.dispatchEvent(new window.Event('ended'))
    })
    expect(media.currentTime).equals(0)
    await act(async () => {
      Object.defineProperty(media, 'duration', {
        configurable: true,
        value: 60
      })
      media.dispatchEvent(new window.Event('durationchange'))
    })
    expect(media.currentTime).equals(30)
    await act(async () => {
      media.currentTime = 32
      media.dispatchEvent(new window.Event('timeupdate'))
    })
    expect(media.currentTime).equals(32)
    await act(async () => {
      media.currentTime = 60
      media.dispatchEvent(new window.Event('ended'))
    })
    expect(media.currentTime).equals(30)
    await act(async () => {
      Object.defineProperty(media, 'error', {
        configurable: true,
        value: { code: 3, message: 'failed' }
      })
      media.dispatchEvent(new window.Event('error'))
    })
    expect(errors).equals(1)
  })
  it('does not play a live preview without an absolute seekable window', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <MidpointPreview
          uri="https://example.test/live.m3u8"
          live
          muted={false}
          testID="preview"
          onError={() => {}}
        />
      )
    })
    const media = document.querySelector('video')!
    await act(async () => {
      Object.defineProperty(media, 'duration', {
        configurable: true,
        value: 120
      })
      media.dispatchEvent(new window.Event('durationchange'))
      media.dispatchEvent(new window.Event('seeked'))
    })
    expect(media.currentTime).equals(0)
    expect(media.paused).equals(true)
  })
})
