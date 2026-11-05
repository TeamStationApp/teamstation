/* eslint-disable @typescript-eslint/unbound-method -- The test swaps AccessibilityInfo and Animated functions and puts them back. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { AccessibilityInfo, Animated } from 'react-native'

import { type FrameClock, installFrameClock } from '../../test/frameClock'
import { byTestId, render, settle, unmount } from '../../test/tessTestKit'
import {
  TessWaveform,
  WAVE_DOT,
  WAVE_FRAME_MS,
  WAVE_GROW_MS,
  WAVE_MIN_SPACING,
  WAVE_SAMPLES,
  waveHeight
} from './TessWaveform'
import type { LevelSource } from './useTessMicrophone'

const WIDTH = 240
const LINE = 22
const SPACING = WIDTH / WAVE_SAMPLES
/** Where a new sample's bar starts: its left edge, a dot in from the right. */
const NEWEST = WIDTH - WAVE_DOT

let clock: FrameClock | undefined

/** A run of the strip's scroll, as `TessWaveform` started it. */
interface Run {
  value: Animated.Value
  from: number
  to: number
  duration: number
  native: boolean
  startedAt: number
  stopped: boolean
}
let runs: Run[] = []
const realTiming = Animated.timing
/** `Animated`, whose `timing` the test replaces. */
const animated = Animated as { timing: typeof Animated.timing }
/**
 * Runs the strip's scroll on the frame clock: under test React Native's
 * animations jump to their end at once, so each run started is recorded,
 * and `advance` moves its value on as the clock goes, steadily.
 */
function scrolls(): FrameClock {
  const installed = installFrameClock()
  runs = []
  animated.timing = ((value: Animated.Value, config) => {
    const run: Run = {
      value,
      from: (value as unknown as { __getValue: () => number }).__getValue(),
      to: config.toValue as number,
      duration: config.duration ?? 0,
      native: config.useNativeDriver,
      startedAt: installed.now(),
      stopped: false
    }
    return {
      start: () => {
        runs.push(run)
      },
      stop: () => {
        run.stopped = true
      },
      reset: () => undefined
    }
  }) as typeof Animated.timing
  return installed
}
let restoreMotion: (() => void) | undefined
function motion(reduced: boolean): void {
  const original = AccessibilityInfo.isReduceMotionEnabled
  AccessibilityInfo.isReduceMotionEnabled = async () => reduced
  restoreMotion = () => {
    AccessibilityInfo.isReduceMotionEnabled = original
  }
}

function source(): LevelSource & { play: (level: number) => void } {
  const listeners = new Set<(level: number) => void>()
  return {
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    play: level => {
      for (const listener of listeners) listener(level)
    }
  }
}

interface Bar {
  x: number
  height: number
  opacity: number
}

/** The number in `transform` that `name` takes, if it has one. */
function transformed(node: Element, name: string): number | null {
  const found = new RegExp(`${name}\\((-?[\\d.e+-]+)`).exec(
    (node as HTMLElement).style.transform
  )
  return found == null ? null : Number(found[1])
}

/**
 * The bars as they show: where each one's left edge is on the strip (its
 * place plus how far the strip has slid), how tall it is (its height as it
 * is scaled) and how opaque. One faded out entirely is not shown.
 */
function bars(): Bar[] {
  const strip = document.body.querySelector('[data-testid="Tess wave strip"]')
  if (strip == null) return []
  const slid = transformed(strip, 'translateX') ?? 0
  return [...strip.querySelectorAll('[data-testid="Tess wave bar"]')]
    .map(node => {
      const { style } = node as HTMLElement
      return {
        x: Number.parseFloat(style.left) + slid,
        height:
          Number.parseFloat(style.height) * (transformed(node, 'scaleY') ?? 1),
        opacity: style.opacity === '' ? 1 : Number(style.opacity)
      }
    })
    .filter(bar => bar.opacity > 0)
}

/** Draws the strip `WIDTH` wide, as its layout reports. */
async function strip(levels: LevelSource): Promise<void> {
  await render(<TessWaveform levels={levels} height={LINE} color="#d00" />)
  await settle()
  const node = byTestId('Tess waveform') as unknown as {
    __reactLayoutHandler: (event: object) => void
  }
  await act(async () => {
    node.__reactLayoutHandler({
      nativeEvent: {
        layout: { x: 0, y: 0, width: WIDTH, height: LINE }
      }
    })
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    clock!.advance(ms)
    const run = runs.at(-1)
    if (run == null || run.stopped) return
    const done = Math.min(1, (clock!.now() - run.startedAt) / run.duration)
    run.value.setValue(run.from + (run.to - run.from) * done)
  })
}

describe("Tess's waveform", function () {
  afterEach(async () => {
    await unmount()
    clock?.restore()
    clock = undefined
    animated.timing = realTiming
    runs = []
    restoreMotion?.()
    restoreMotion = undefined
  })

  it('is a dot at silence, and a line as tall as the sound up to the line', function () {
    expect(waveHeight(0, LINE)).equals(WAVE_DOT)
    expect(waveHeight(-1, LINE)).equals(WAVE_DOT)
    expect(waveHeight(0.25, LINE)).equals(LINE)
    expect(waveHeight(1, LINE)).equals(LINE)
    expect(waveHeight(0.04, LINE)).closeTo(0.4 * LINE, 1e-9)
  })

  it('takes each sample in at the right edge as a dot, grows it, and moves it left, fading', async function () {
    motion(false)
    clock = scrolls()
    const levels = source()
    await strip(levels)
    await act(async () => {
      levels.play(0.25)
    })
    let [bar] = bars()
    expect(bar.x).closeTo(NEWEST, 1e-9)
    expect(bar.height).equals(WAVE_DOT)
    expect(bar.opacity).equals(1)
    // Between frames it moves on, and grows into its line.
    await advance(48)
    ;[bar] = bars()
    expect(bar.x).closeTo(NEWEST - (48 / WAVE_FRAME_MS) * SPACING, 1e-9)
    expect(bar.height).closeTo(
      WAVE_DOT + (LINE - WAVE_DOT) * (48 / WAVE_GROW_MS),
      1e-9
    )
    await advance(WAVE_GROW_MS)
    ;[bar] = bars()
    expect(bar.height).equals(LINE)
    // The next enters on its right.
    await act(async () => {
      levels.play(0)
    })
    const [older, newer] = bars()
    expect(older.x).lessThan(newer.x)
    expect(newer.x).closeTo(NEWEST, 1e-9)
    expect(newer.height).equals(WAVE_DOT)
    // In the left half it fades, and it is gone past the left edge.
    await advance(1600)
    ;[bar] = bars()
    expect(bar.x).lessThan(WIDTH / 2)
    expect(bar.opacity).lessThan(1)
    // Measured at its middle.
    expect(bar.opacity).closeTo((bar.x + WAVE_DOT / 2) / (WIDTH / 2), 1e-9)
    await advance(1200)
    expect(bars()).deep.equals([])
  })

  it(`keeps the last ${WAVE_SAMPLES} samples`, async function () {
    motion(false)
    clock = scrolls()
    const levels = source()
    await strip(levels)
    await act(async () => {
      for (let n = 0; n < WAVE_SAMPLES + 6; n++) levels.play(0.01)
    })
    expect(bars()).has.length(WAVE_SAMPLES)
  })

  it('with reduced motion stands each bar in its place and changes only heights', async function () {
    motion(true)
    clock = scrolls()
    const levels = source()
    await strip(levels)
    await act(async () => {
      levels.play(1)
    })
    // Full height at once, at the right edge.
    expect(bars()).deep.equals([{ x: NEWEST, height: LINE, opacity: 1 }])
    await advance(1000)
    expect(bars()).deep.equals([{ x: NEWEST, height: LINE, opacity: 1 }])
    await act(async () => {
      levels.play(0)
    })
    const [older, newer] = bars()
    expect(older.x).closeTo(NEWEST - SPACING, 1e-9)
    expect(older.height).equals(LINE)
    expect(newer).deep.equals({ x: NEWEST, height: WAVE_DOT, opacity: 1 })
  })

  it('keeps samples apart on a narrow strip, showing fewer', async function () {
    motion(true)
    clock = scrolls()
    const levels = source()
    await render(<TessWaveform levels={levels} height={LINE} color="#d00" />)
    await settle()
    const node = byTestId('Tess waveform') as unknown as {
      __reactLayoutHandler: (event: object) => void
    }
    await act(async () => {
      node.__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: 40, height: LINE } }
      })
    })
    await act(async () => {
      for (let n = 0; n < WAVE_SAMPLES; n++) levels.play(0.1)
    })
    const xs = bars().map(bar => bar.x)
    expect(xs).has.length(7)
    for (let n = 1; n < xs.length; n++)
      expect(xs[n] - xs[n - 1]).closeTo(WAVE_MIN_SPACING, 1e-9)
  })

  it('draws nothing, and runs nothing, until it knows its width', async function () {
    motion(false)
    clock = scrolls()
    const levels = source()
    await render(<TessWaveform levels={levels} height={LINE} color="#d00" />)
    await settle()
    await act(async () => {
      levels.play(0.5)
    })
    await advance(500)
    expect(bars()).deep.equals([])
    expect(runs).deep.equals([])
    await unmount()
    // Unmounted, it stops listening.
    levels.play(0.5)
  })

  it('slides the strip as one animation, on the native driver where there is one, and asks for no frames of its own', async function () {
    motion(false)
    clock = scrolls()
    const asked: number[] = []
    const request = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = callback => {
      asked.push(1)
      return request(callback)
    }
    try {
      const levels = source()
      await strip(levels)
      await act(async () => {
        levels.play(0.25)
      })
      await advance(1000)
      expect(runs).has.length(1)
      // The web has none: there it runs on JavaScript.
      expect(runs[0]).deep.include({ native: false, stopped: false })
      expect(asked).deep.equals([])
      // Each sample heard runs it on from where it is.
      await act(async () => {
        levels.play(0.25)
      })
      expect(runs).has.length(2)
      expect(runs[0].stopped).equals(true)
      // The strip began at the clock's start, a thousand.
      expect(runs[1].from).closeTo(
        -((clock.now() - 1000) / WAVE_FRAME_MS) * SPACING,
        1e-9
      )
      await unmount()
      expect(runs[1].stopped).equals(true)
    } finally {
      globalThis.requestAnimationFrame = request
    }
  })
})
