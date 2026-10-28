import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { defaultScoreboardSettings } from '../../../common/nodeSettings'
import { getTheme, ThemeProvider, useTheme } from '../../theme/ThemeContext'
import { MultiCamBar } from '../MultiCamBar'
import {
  clock,
  ExitButton,
  exitClearance,
  exitTopClear,
  fractionOf,
  gridControls,
  TrackStrips
} from './barParts'
import { playerLayout } from './playerLayout'

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

  it('is the time, the track and the total: no buttons, and no way out (U15)', async function () {
    const widths: number[] = []
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const slider = (): HTMLElement =>
      host!.querySelector<HTMLElement>('[role="slider"]')!
    // jsdom lays nothing out: the track says it is 320 px across. On the
    // div's own prototype, ahead of anything another suite has put on the
    // ones above it.
    const prototype = window.HTMLDivElement.prototype
    const above = Object.getPrototypeOf(prototype) as HTMLElement
    const own = Object.getOwnPropertyDescriptor(
      prototype,
      'getBoundingClientRect'
    )
    Object.defineProperty(prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function (this: HTMLDivElement): DOMRect {
        return this.getAttribute('role') === 'slider'
          ? new window.DOMRect(0, 0, 320, 24)
          : Reflect.apply(Reflect.get(above, 'getBoundingClientRect'), this, [])
      }
    })
    try {
      await act(async () => {
        root?.render(
          <ThemeProvider>
            <MultiCamBar
              window={{ fromMs: 0, toMs: 60_000 }}
              atMs={30_000}
              angles={[]}
              onTrackRect={rect => widths.push(rect.w)}
              visible
            />
          </ThemeProvider>
        )
      })
      expect(slider()).not.equals(null)
      for (const label of [
        'Pause',
        'Play',
        'Back ten seconds',
        'Forward ten seconds',
        'Close'
      ])
        expect(host.querySelector(`[aria-label="${label}"]`), label).equals(
          null
        )
      expect(host.textContent).not.includes('replay_10')
      expect(host.textContent).not.includes('✕')
      expect(host.textContent).includes('0:30')
      expect(host.textContent).includes('1:00')
      // Its width, on mount and when the window changes.
      expect(widths).deep.equals([320])
      await act(async () => {
        window.dispatchEvent(new window.Event('resize'))
      })
      expect(widths).deep.equals([320, 320])
    } finally {
      if (own != null)
        Object.defineProperty(prototype, 'getBoundingClientRect', own)
      else Reflect.deleteProperty(prototype, 'getBoundingClientRect')
    }
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

  it('sits on the block it is given, and takes no pointer', async function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <ThemeProvider>
          <MultiCamBar
            window={{ fromMs: 0, toMs: 100_000 }}
            atMs={0}
            angles={[]}
            visible
            frame={{ left: 40, width: 600, bottom: 120 }}
          />
        </ThemeProvider>
      )
    })
    const bar = host.firstElementChild as HTMLElement
    expect(bar.style.left).equals('40px')
    expect(bar.style.width).equals('600px')
    expect(bar.style.bottom).equals('120px')
    // A press on the track is the press grid's, under it: nothing here.
    expect(bar.style.pointerEvents).equals('none')
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

describe('the full-screen controls (gridControls)', function () {
  it('put the sound in the top-left corner, level with the ✕, over the board', function () {
    const theme = getTheme()
    const safe = { x: 59, y: 0, w: 874 - 2 * 59, h: 402 - 21 }
    const layout = playerLayout({
      screen: { width: 874, height: 402 },
      safe,
      count: 1,
      aspect: 16 / 9,
      landscape: true,
      settings: {
        show: true,
        single: defaultScoreboardSettings.single,
        landscape: defaultScoreboardSettings.landscape,
        portraitHeight: defaultScoreboardSettings.portraitHeight
      },
      board: { width: 607, height: 247 },
      line: true
    })
    const { block, icons } = gridControls(theme, layout, safe, 874, null)
    const sound = icons.find(icon => icon.zone === 'audio')!
    const exit = icons.find(icon => icon.zone === 'corner')!
    expect(sound.y).closeTo(exit.y, 0.01)
    expect(sound.x - block.x).closeTo(block.x + block.w - exit.x, 0.01)
    // The board is over that corner of the picture: the sound is over it.
    expect(layout.board).not.equals(null)
    expect(sound.y).lessThan(layout.board!.y + layout.board!.h)
  })

  it('keep the sound level with the ✕ when the board pushes the ✕ down', function () {
    const theme = getTheme()
    const safe = { x: 59, y: 0, w: 874 - 2 * 59, h: 402 - 21 }
    const layout = playerLayout({
      screen: { width: 874, height: 402 },
      safe,
      count: 1,
      aspect: 16 / 9,
      landscape: true,
      settings: null,
      board: null,
      line: false
    })
    const open = gridControls(theme, layout, safe, 874, null)
    // A board in the block's top-right corner, where the ✕ would be.
    const board = {
      x: open.block.x + open.block.w - 300,
      y: open.block.y,
      w: 300,
      h: 90
    }
    const { icons, exitTop } = gridControls(
      theme,
      { ...layout, board },
      safe,
      874,
      null
    )
    expect(exitTop).greaterThan(board.y + board.h)
    const sound = icons.find(icon => icon.zone === 'audio')!
    const exit = icons.find(icon => icon.zone === 'corner')!
    expect(sound.y).closeTo(exit.y, 0.01)
  })
})
