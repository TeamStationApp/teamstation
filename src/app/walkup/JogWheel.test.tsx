import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import type { Clip } from './clipModel'
import { JogWheel, TOOTH_PITCH, wheelTeeth } from './JogWheel'

/**
 * The jog wheel: its edge-on teeth, and a drag that moves the window a
 * quarter as fast as the timeline, with a tick per step.
 */
let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
let ticks = 0
const navigatorOf = window.navigator as Navigator & {
  vibrate?: (pattern: number) => boolean
}
const hadVibrate = Object.prototype.hasOwnProperty.call(navigatorOf, 'vibrate')

beforeEach(function () {
  ticks = 0
  Object.defineProperty(navigatorOf, 'vibrate', {
    configurable: true,
    value: () => {
      ticks++
      return true
    }
  })
})

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  if (!hadVibrate) Reflect.deleteProperty(navigatorOf, 'vibrate')
})

describe('wheelTeeth', function () {
  it('draws only the front half of the wheel, across its width', function () {
    const teeth = wheelTeeth(0, 300)
    expect(teeth.length).equals(Math.round(Math.PI / TOOTH_PITCH) - 1)
    for (const tooth of teeth) {
      expect(tooth.x).within(0, 300)
      expect(tooth.width).greaterThan(0)
    }
    expect(wheelTeeth(0, 0)).deep.equals([])
  })

  it('makes the middle tooth the widest and brightest, crowding towards the ends', function () {
    const teeth = wheelTeeth(0, 300)
    const middle = teeth.reduce((best, tooth) =>
      Math.abs(tooth.x - 150) < Math.abs(best.x - 150) ? tooth : best
    )
    expect(middle.x).closeTo(150, 1e-9)
    for (const tooth of teeth) {
      expect(tooth.width).at.most(middle.width + 1e-9)
      expect(tooth.opacity).at.most(middle.opacity + 1e-9)
    }
    const right = teeth.filter(tooth => tooth.x >= 150)
    const gaps = right.slice(1).map((tooth, i) => tooth.x - right[i].x)
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).lessThan(gaps[i - 1])
    }
    expect(right[right.length - 1].opacity).lessThan(0.4)
  })

  it('turns one pitch back to the same teeth', function () {
    const still = wheelTeeth(0, 300)
    const turned = wheelTeeth(TOOTH_PITCH, 300)
    expect(turned.length).equals(still.length)
    turned.forEach((tooth, i) => {
      expect(tooth.x).closeTo(still[i].x, 1e-6)
    })
    expect(wheelTeeth(TOOTH_PITCH / 2, 300)[0].x).not.closeTo(still[0].x, 1e-3)
  })
})

describe('JogWheel', function () {
  interface Recorded {
    changes: Clip[]
    commits: Clip[]
  }

  async function render(timelineWidth = 400): Promise<Recorded> {
    const recorded: Recorded = { changes: [], commits: [] }
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    function Harness(): React.ReactElement {
      const [clip, setClip] = React.useState<Clip>({
        startMs: 10000,
        endMs: 25000
      })
      return (
        <JogWheel
          clip={clip}
          durationMs={180000}
          timelineWidth={timelineWidth}
          onChange={next => {
            recorded.changes.push(next)
            setClip(next)
          }}
          onCommit={next => {
            recorded.commits.push(next)
          }}
        />
      )
    }
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <Harness />
        </ThemeProvider>
      )
      await delay(10)
    })
    return recorded
  }

  async function drag(xs: number[]): Promise<void> {
    const wheel = document.querySelector<HTMLElement>(
      '[data-testid="walkup-jog"]'
    )!
    await act(async () => {
      wheel.dispatchEvent(
        new window.MouseEvent('mousedown', {
          bubbles: true,
          clientX: xs[0],
          button: 0
        })
      )
      for (const x of xs.slice(1, -1)) {
        document.dispatchEvent(
          new window.MouseEvent('mousemove', {
            bubbles: true,
            clientX: x,
            buttons: 1
          })
        )
      }
      document.dispatchEvent(
        new window.MouseEvent('mouseup', {
          bubbles: true,
          clientX: xs[xs.length - 1]
        })
      )
      await delay(10)
    })
  }

  it('moves the window a quarter of the timeline’s rate, ticking on each move that crosses a step', async function () {
    const recorded = await render()
    // On a 400 pt timeline of a 180 s song, a point of the wheel is 112.5 ms.
    await drag([100, 101, 102, 103, 140, 140])
    expect(recorded.changes.map(clip => clip.startMs)).deep.equals([
      10100, 10200, 10300, 14500
    ])
    expect(ticks).equals(4)
    expect(recorded.commits).deep.equals([{ startMs: 14500, endMs: 29500 }])
  })

  it('commits nothing and ticks nothing for a touch that crosses no step', async function () {
    const recorded = await render()
    await drag([100, 100, 100])
    expect(recorded.changes).deep.equals([])
    expect(recorded.commits).deep.equals([])
    expect(ticks).equals(0)
  })

  it('applies a move first seen at the release', async function () {
    const recorded = await render()
    await drag([100, 60])
    expect(recorded.changes).deep.equals([{ startMs: 5500, endMs: 20500 }])
    expect(recorded.commits).deep.equals([{ startMs: 5500, endMs: 20500 }])
  })

  it('moves nothing before the timeline is laid out', async function () {
    const recorded = await render(0)
    await drag([100, 140, 140])
    expect(recorded.changes).deep.equals([])
    expect(recorded.commits).deep.equals([])
  })
})
