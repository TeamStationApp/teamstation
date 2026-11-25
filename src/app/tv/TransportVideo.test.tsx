import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { VideoRef } from 'react-native-video'

import { TransportVideo } from './TransportVideo'

describe('TV paused transport rate', () => {
  it('holds the native rate stable while paused and restores it on resume', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const ref = createRef<VideoRef>()
    const render = async (paused: boolean, rate?: number): Promise<void> => {
      await act(async () => {
        root.render(<TransportVideo ref={ref} paused={paused} rate={rate} />)
      })
    }
    try {
      await render(true, 0.25)
      const video = host.querySelector('video')!
      expect(video.playbackRate).equals(1)
      await render(true, 1)
      expect(video.playbackRate).equals(1)
      await render(false, 0.25)
      expect(video.playbackRate).equals(0.25)
      await render(true, 0.25)
      await render(true, 1)
      // No 0.25 -> 1 native setter call while paused, including on release.
      expect(video.playbackRate).equals(0.25)
      await render(false)
      expect(video.playbackRate).equals(1)
      expect(host.querySelector('video')).equals(video)
      expect(ref.current?.seek).is.a('function')
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })

  it('hands its volume to the camera’s player, full when not given (U27)', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<TransportVideo paused />)
      })
      // The browser build of the player scales the prop; the TV's takes it
      // as it is. Either way the camera plays at a fifth of full.
      const video = host.querySelector('video')!
      const full = video.volume
      expect(full).greaterThan(0)
      await act(async () => {
        root.render(<TransportVideo paused volume={0.2} />)
      })
      expect(video.volume / full).closeTo(0.2, 1e-6)
      await act(async () => {
        root.render(<TransportVideo paused volume={1} />)
      })
      expect(video.volume).equals(full)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
