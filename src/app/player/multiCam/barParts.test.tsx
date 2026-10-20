import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider, useTheme } from '../../theme/ThemeContext'
import { MultiCamBar } from '../MultiCamBar'
import {
  clock,
  ExitButton,
  exitClearance,
  exitTopClear,
  fractionOf,
  TrackStrips,
  TransportButtons
} from './barParts'

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

describe('the multi-camera bar’s parts', function () {
  it('draws the ten-second buttons as icons, and each one does what it says', async function () {
    const skips: number[] = []
    let toggled = 0
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <TransportButtons
            playing
            onTogglePlay={() => {
              toggled++
            }}
            onSkip={delta => {
              skips.push(delta)
            }}
          />
        </ThemeProvider>
      )
    })
    // Material Symbols draws a ligature from the icon's name; the arrow
    // characters it replaces are missing from Android's fonts.
    expect(host.textContent).includes('replay_10')
    expect(host.textContent).includes('forward_10')
    expect(host.textContent).not.includes('⏴')
    const press = async (label: string): Promise<void> => {
      const node = host?.querySelector<HTMLElement>(`[aria-label="${label}"]`)
      if (node == null) throw new Error(`no ${label}`)
      await act(async () => {
        node.click()
      })
    }
    await press('Back ten seconds')
    await press('Forward ten seconds')
    await press('Pause')
    expect(skips).deep.equals([-10, 10])
    expect(toggled).equals(1)
  })

  it('reads the take’s clock and where an instant falls in it', function () {
    expect(clock(65_000)).equals('1:05')
    expect(clock(3_725_000)).equals('1:02:05')
    expect(clock(-5)).equals('0:00')
    const take = { fromMs: 1000, toMs: 11_000 }
    expect(fractionOf(take, 6000)).equals(0.5)
    expect(fractionOf(take, 0)).equals(0)
    expect(fractionOf(take, 20_000)).equals(1)
  })

  it('draws a strip per angle, the part played and the playhead', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const take = { fromMs: 0, toMs: 100_000 }
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <TrackStrips
            take={take}
            atMs={25_000}
            angles={[
              { id: 'A', name: 'A', fromMs: 0, toMs: 100_000 },
              { id: 'B', name: 'B', fromMs: 50_000, toMs: 100_000 }
            ]}
          />
        </ThemeProvider>
      )
    })
    const widths = Array.from(host.querySelectorAll<HTMLElement>('div')).map(
      node => node.style.width
    )
    expect(widths).includes('100%')
    expect(widths).includes('50%')
    expect(widths).includes('25%')
  })

  it('shows the way out at the top right only while asked, and it closes', async function () {
    let closed = 0
    const render = async (visible: boolean): Promise<HTMLElement> => {
      await act(async () => {
        root?.render(
          <ThemeProvider>
            <ExitButton
              visible={visible}
              top={20}
              onPress={() => {
                closed++
              }}
            />
          </ThemeProvider>
        )
      })
      const button = host?.querySelector<HTMLElement>('[aria-label="Close"]')
      if (button?.parentElement == null) throw new Error('no Close')
      return button.parentElement
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const shown = await render(true)
    expect(shown.style.opacity).equals('1')
    expect(parseFloat(shown.style.right)).greaterThan(0)
    expect(parseFloat(shown.style.top)).greaterThan(20)
    await act(async () => {
      host?.querySelector<HTMLElement>('[aria-label="Close"]')?.click()
    })
    expect(closed).equals(1)
    const hidden = await render(false)
    expect(hidden.style.opacity).equals('0')
    expect(getComputedStyle(hidden).pointerEvents).equals('none')
  })

  it('keeps no way out on the bar itself', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <MultiCamBar
            window={{ fromMs: 0, toMs: 60_000 }}
            atMs={30_000}
            playing
            angles={[]}
            onTogglePlay={() => undefined}
            onSkip={() => undefined}
            onScrub={() => undefined}
            onInteract={() => undefined}
            visible
          />
        </ThemeProvider>
      )
    })
    expect(host.querySelector('[aria-label="Pause"]')).not.equals(null)
    expect(host.querySelector('[aria-label="Close"]')).equals(null)
    expect(host.textContent).not.includes('✕')
  })

  it('says how much of the corner the way out takes', async function () {
    let clearance = 0
    function Probe(): null {
      clearance = exitClearance(useTheme())
      return null
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      )
    })
    expect(clearance).greaterThan(40)
  })

  describe('the track while the page wants a swipe up', function () {
    /** The bar's track, 200 px wide from the left edge, and a way to touch it. */
    async function track(panPage: boolean): Promise<{
      slider: HTMLElement
      scrubs: number[]
      touch: (type: string, x: number, y: number) => Promise<void>
    }> {
      const scrubs: number[] = []
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => {
        root?.render(
          <ThemeProvider>
            <MultiCamBar
              window={{ fromMs: 0, toMs: 100_000 }}
              atMs={0}
              playing
              angles={[]}
              onTogglePlay={() => undefined}
              onSkip={() => undefined}
              onScrub={ms => scrubs.push(ms)}
              onInteract={() => undefined}
              visible
              panPage={panPage}
            />
          </ThemeProvider>
        )
      })
      const slider = host.querySelector<HTMLElement>('[role="slider"]')
      if (slider == null) throw new Error('no track')
      const box = new window.DOMRect(0, 0, 200, 72)
      slider.getBoundingClientRect = () => box
      const touch = async (
        type: string,
        x: number,
        y: number
      ): Promise<void> => {
        const event = new window.MouseEvent(type, {
          bubbles: true,
          clientX: x,
          clientY: y
        })
        Object.defineProperty(event, 'pointerId', { value: 7 })
        await act(async () => {
          slider.dispatchEvent(event)
        })
      }
      return { slider, scrubs, touch }
    }

    it('lets a vertical drag through to the page and scrubs nothing', async function () {
      const { slider, scrubs, touch } = await track(true)
      expect(slider.style.touchAction).equals('pan-y')
      await touch('pointerdown', 100, 40)
      expect(scrubs).deep.equals([])
      // Mostly upwards: the browser's to scroll, and it cancels the pointer.
      await touch('pointermove', 104, 10)
      await touch('pointercancel', 104, 10)
      await touch('pointerup', 104, 10)
      expect(scrubs).deep.equals([])
    })

    it('scrubs on a sideways drag, and seeks on a tap', async function () {
      const { scrubs, touch } = await track(true)
      await touch('pointerdown', 100, 40)
      await touch('pointermove', 150, 42)
      await touch('pointermove', 160, 42)
      await touch('pointerup', 160, 42)
      expect(scrubs).deep.equals([75_000, 80_000])
      await touch('pointerdown', 50, 40)
      await touch('pointerup', 51, 40)
      expect(scrubs.at(-1)).equals(25_500)
    })

    it('otherwise keeps every drag, scrubbing from the first touch', async function () {
      const { slider, scrubs, touch } = await track(false)
      expect(slider.style.touchAction).equals('none')
      await touch('pointerdown', 100, 40)
      await touch('pointermove', 102, 10)
      await touch('pointerup', 102, 10)
      expect(scrubs).deep.equals([50_000, 51_000])
    })
  })
})

describe('the way out, clear of the board (exitTopClear)', function () {
  const spot = { x: 350, y: 8, w: 44, h: 44 }

  it('stays in the top right when nothing reaches there', function () {
    expect(
      exitTopClear(spot, [null, { x: 0, y: 0, w: 300, h: 120 }], 8)
    ).equals(8)
  })

  it('goes under the board, and on under the box score below it', function () {
    const board = { x: 8, y: 0, w: 386, h: 120 }
    expect(exitTopClear(spot, [board, null], 8)).equals(128)
    // The box is under the board: the ✕ goes under both, whatever the order.
    const box = { x: 8, y: 125, w: 386, h: 60 }
    expect(exitTopClear(spot, [box, board], 8)).equals(193)
  })
})
