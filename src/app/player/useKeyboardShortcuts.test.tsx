import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import type { VideoHandle } from './videoHandle'
import { HOLD_MS } from './zones'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

/** What the keys asked for, in order. */
async function keys(): Promise<string[]> {
  const did: string[] = []
  let crawling = false
  const video = {} as unknown as VideoHandle
  function Probe(): null {
    useKeyboardShortcuts({
      video: () => video,
      act: zone => did.push(zone),
      seek: delta => did.push(`seek ${delta}`),
      beginSlow: action => {
        crawling = true
        did.push(`begin ${action}`)
      },
      endSlow: () => {
        if (crawling) did.push('end')
        crawling = false
      },
      holding: () => crawling
    })
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<Probe />)
  })
  return did
}

const key = async (
  type: 'keydown' | 'keyup',
  name: string,
  repeat = false
): Promise<void> => {
  await act(async () => {
    document.body.dispatchEvent(
      new window.KeyboardEvent(type, { key: name, repeat, bubbles: true })
    )
  })
}
const wait = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

describe('the keys in the full-screen player (U16)', function () {
  this.timeout(5000)

  it('skips ten seconds on a tapped Right, when it comes up', async function () {
    const did = await keys()
    await key('keydown', 'ArrowRight')
    expect(did).deep.equals([])
    await wait(100)
    await key('keyup', 'ArrowRight')
    expect(did).deep.equals(['seek 10'])
  })

  it('crawls on a Right held half a second, ends on its keyup, and skips nothing', async function () {
    const did = await keys()
    await key('keydown', 'ArrowRight')
    await wait(HOLD_MS - 150)
    expect(did).deep.equals([])
    // A held key repeats; none of them is another press.
    await key('keydown', 'ArrowRight', true)
    await wait(250)
    expect(did).deep.equals(['begin slowForward'])
    await key('keydown', 'ArrowRight', true)
    await key('keyup', 'ArrowRight')
    expect(did).deep.equals(['begin slowForward', 'end'])
  })

  it('never crawls for a Right held while the window loses focus, nor once gone', async function () {
    const did = await keys()
    await key('keydown', 'ArrowRight')
    await act(async () => {
      window.dispatchEvent(new window.Event('blur'))
    })
    await wait(HOLD_MS + 100)
    expect(did).deep.equals([])
    // Its keyup, if it comes, skips nothing either.
    await key('keyup', 'ArrowRight')
    expect(did).deep.equals([])
    await key('keydown', 'ArrowRight')
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await wait(HOLD_MS + 100)
    expect(did).deep.equals([])
  })

  it('ends a crawl only by the key that started it', async function () {
    this.timeout(5000)
    const did = await keys()
    // Up holds a crawl; a Right held under it starts and ends nothing.
    await key('keydown', 'ArrowUp')
    await key('keydown', 'ArrowRight')
    await wait(HOLD_MS + 100)
    await key('keyup', 'ArrowRight')
    expect(did, 'still crawling for Up').deep.equals(['begin slowForward'])
    await key('keyup', 'ArrowUp')
    expect(did).deep.equals(['begin slowForward', 'end'])
    // And the other way round: Right holds it, an Up pressed under it is
    // refused and its keyup ends nothing.
    await key('keydown', 'ArrowRight')
    await wait(HOLD_MS + 100)
    await key('keydown', 'ArrowUp')
    await key('keyup', 'ArrowUp')
    expect(did.slice(2), 'still crawling for Right').deep.equals([
      'begin slowForward'
    ])
    await key('keyup', 'ArrowRight')
    expect(did.slice(2)).deep.equals(['begin slowForward', 'end'])
  })

  it('leaves Left, the Up hold and play as they were', async function () {
    const did = await keys()
    await key('keydown', 'ArrowLeft')
    await key('keydown', 'ArrowLeft', true)
    await key('keyup', 'ArrowLeft')
    await key('keydown', 'ArrowUp')
    await key('keydown', 'ArrowUp', true)
    await key('keyup', 'ArrowUp')
    await key('keydown', 'k')
    expect(did).deep.equals([
      'seek -10',
      'seek -10',
      'begin slowForward',
      'end',
      'toggle'
    ])
  })
})
