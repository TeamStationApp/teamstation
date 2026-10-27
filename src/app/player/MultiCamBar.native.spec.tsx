import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { MultiCamBar } from './MultiCamBar.native'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

describe("the phone's bar (U33b)", function () {
  it('has no buttons, says how wide its track is, and scrubs on a drag along it', async function () {
    const widths: number[] = []
    const scrubs: Array<[number, boolean]> = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <MultiCamBar
            window={{ fromMs: 0, toMs: 100_000 }}
            atMs={25_000}
            angles={[]}
            onScrub={(ms, final) => scrubs.push([ms, final === true])}
            onTrackWidth={px => widths.push(px)}
            onInteract={() => undefined}
            visible
          />
        </ThemeProvider>
      )
    })
    for (const label of [
      'Pause',
      'Play',
      'Back ten seconds',
      'Forward ten seconds'
    ])
      expect(host.querySelector(`[aria-label="${label}"]`), label).equals(null)
    expect(host.textContent).not.includes('replay_10')

    const track = host.querySelector<HTMLElement>(
      '[aria-label="Position in the game"]'
    )!
    // react-native-web hands a view's layout to the handler it keeps on the
    // element, as its resize observer would.
    const layout = (
      track as unknown as {
        __reactLayoutHandler: (event: {
          nativeEvent: { layout: { width: number; height: number } }
        }) => void
      }
    ).__reactLayoutHandler
    await act(async () => {
      layout({ nativeEvent: { layout: { width: 200, height: 48 } } })
    })
    expect(widths).deep.equals([200])

    const mouse = async (type: string, x: number): Promise<void> => {
      await act(async () => {
        track.dispatchEvent(
          new window.MouseEvent(type, {
            bubbles: true,
            clientX: x,
            clientY: 10,
            button: 0,
            buttons: type === 'mouseup' ? 0 : 1
          })
        )
      })
    }
    await mouse('mousedown', 50)
    await mouse('mousemove', 150)
    await mouse('mouseup', 150)
    // The finger lifting lands where it lifts.
    expect(scrubs).deep.equals([
      [25_000, false],
      [75_000, false],
      [75_000, true]
    ])
  })
})
