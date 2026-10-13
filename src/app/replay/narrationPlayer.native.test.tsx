import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { otherAudioSounding } from '../scoring/cueSoundsController'
import { useNarrationPlayer } from './narrationPlayer.native'
import type { NarrationClient, NarrationPlayer } from './narrationPlayerTypes'
import type { NarrationStep } from './narrationQueue'

const client: NarrationClient = {
  narrationAudio: async () => new Blob(['mp3']),
  narrationReady: async () => undefined,
  narrationSource: (gameId, step) => ({
    uri: `https://api.example.test/games/${gameId}/narrations/${step.key}?count=${step.count}`,
    headers: {}
  })
}

describe('the announcer on a phone', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined

  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
  })

  it('leaves the audio session to the cues except while a sentence plays', async function () {
    let player: NarrationPlayer<NarrationStep> | undefined
    function Probe(): React.ReactElement | null {
      player = useNarrationPlayer(client, 'gam_1')
      return player.element
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<Probe />)
    })
    // Open with nothing to say: the cues may set the session to ambient.
    expect(otherAudioSounding()).equals(false)
    const step = { key: '0-1', count: 1 }
    await act(async () => {
      player!.output.play(step).catch(() => undefined)
    })
    expect(otherAudioSounding()).equals(true)
    await act(async () => {
      player!.output.stop()
    })
    expect(otherAudioSounding()).equals(false)
    await act(async () => {
      player!.output.play(step).catch(() => undefined)
    })
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(otherAudioSounding()).equals(false)
  })

  it('mounts a fresh player for each sentence, even one read again at the same address', async function () {
    let player: NarrationPlayer<NarrationStep> | undefined
    function Probe(): React.ReactElement | null {
      player = useNarrationPlayer(client, 'gam_1')
      return player.element
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<Probe />)
    })
    const clip = await player!.output.load(
      { key: '3-1', count: 2 },
      new AbortController().signal
    )
    expect(clip).deep.equals({ key: '3-1', count: 2 })
    const media = (): Element | null => host!.querySelector('video')
    await act(async () => {
      player!.output.play(clip).catch(() => undefined)
    })
    const first = media()
    expect(first).not.equals(null)
    // The scorer changed the step being read: it is stopped and read again.
    await act(async () => {
      player!.output.stop()
      player!.output.play(clip).catch(() => undefined)
    })
    const second = media()
    expect(second).not.equals(null)
    expect(second).not.equals(first)
    await act(async () => {
      player!.output.stop()
    })
    expect(media()).equals(null)
  })
})
