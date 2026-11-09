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
  it('offers the live jump only when provided, and ignores hidden activation', async function () {
    const localHost = document.createElement('div')
    document.body.appendChild(localHost)
    root = createRoot(localHost)
    let jumps = 0
    const draw = async (visible: boolean, live: boolean): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <MultiCamBar
              window={{ fromMs: 0, toMs: 100_000 }}
              atMs={25_000}
              angles={[]}
              visible={visible}
              onJumpToPresent={
                live
                  ? () => {
                      jumps++
                    }
                  : undefined
              }
            />
          </ThemeProvider>
        )
      })
    }
    await draw(true, false)
    expect(localHost.querySelector('[data-testid="jumpToPresent"]')).equals(
      null
    )
    await draw(false, true)
    const jump = localHost.querySelector<HTMLElement>(
      '[data-testid="jumpToPresent"]'
    )!
    expect(jump.getAttribute('tabindex')).equals('-1')
    await act(async () => {
      jump.click()
    })
    expect(jumps).equals(0)
    await draw(true, true)
    expect(jump.getAttribute('tabindex')).equals('0')
    await act(async () => {
      jump.click()
    })
    expect(jumps).equals(1)
  })

  it('has no buttons, takes no touch, and says where its track is in the press layer', async function () {
    const rects: Array<{ x: number; w: number }> = []
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
            onTrackRect={rect => rects.push({ x: rect.x, w: rect.w })}
            visible
            frame={{ left: 30, width: 400, bottom: 90 }}
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
          nativeEvent: {
            layout: { x: number; y: number; width: number; height: number }
          }
        }) => void
      }
    ).__reactLayoutHandler
    await act(async () => {
      layout({
        nativeEvent: { layout: { x: 60, y: 8, width: 200, height: 24 } }
      })
    })
    // The frame's left plus the track's own place in the bar.
    expect(rects).deep.equals([{ x: 90, w: 200 }])

    // The press grid's bottom row, under the bar, is the scrub: the bar
    // takes no touch.
    let node: HTMLElement | null = track
    while (node != null && getComputedStyle(node).pointerEvents !== 'none')
      node = node.parentElement
    expect(node, 'the bar takes no touch').not.equals(null)
  })
})
