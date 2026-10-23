import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { CoverableScene, coverAndReveal } from '../../test/coverableScene'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatVideo } from './ChatVideo'

describe('an opened chat video under a pushed screen', function () {
  let root: Root | undefined
  const proto = window.HTMLMediaElement.prototype
  const pause = Object.getOwnPropertyDescriptor(proto, 'pause')!
  const play = Object.getOwnPropertyDescriptor(proto, 'play')!
  const paused = Object.getOwnPropertyDescriptor(proto, 'paused')!
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    Object.defineProperty(proto, 'pause', pause)
    Object.defineProperty(proto, 'play', play)
    Object.defineProperty(proto, 'paused', paused)
  })

  async function drawn(playing: boolean): Promise<string[]> {
    const calls: string[] = []
    Object.defineProperty(proto, 'paused', {
      configurable: true,
      get: () => !playing
    })
    Object.defineProperty(proto, 'pause', {
      configurable: true,
      value: () => {
        calls.push('pause')
      }
    })
    Object.defineProperty(proto, 'play', {
      configurable: true,
      value: async () => {
        calls.push('play')
      }
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <CoverableScene>
            <ChatVideo uri="blob:clip" label="Clip" width={320} height={180} />
          </CoverableScene>
        </ThemeProvider>
      )
    })
    return calls
  }

  it('pauses while covered, and plays again on coming back', async function () {
    const calls = await drawn(true)
    await coverAndReveal()
    expect(calls).deep.equals(['pause', 'play'])
  })

  it('leaves a video the person had paused paused', async function () {
    const calls = await drawn(false)
    await coverAndReveal()
    expect(calls).deep.equals(['pause'])
  })
})
