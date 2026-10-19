/* eslint-disable @typescript-eslint/unbound-method -- Restore mocked animation and accessibility APIs. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, Animated } from 'react-native'

import { UndoTicker } from './UndoTicker'

const original = {
  loop: Animated.loop,
  sequence: Animated.sequence,
  timing: Animated.timing,
  delay: Animated.delay,
  query: AccessibilityInfo.isReduceMotionEnabled,
  subscribe: AccessibilityInfo.addEventListener
}
let root: Root | undefined
let host: HTMLElement
let starts = 0
let stops = 0
let delays: number[] = []
let timings: Array<{ toValue: unknown; duration?: number }> = []
let reducedChanged: (value: boolean) => void
function mock(): void {
  starts = 0
  stops = 0
  delays = []
  timings = []
  const animation = {
    start: () => {
      starts++
    },
    stop: () => {
      stops++
    },
    reset: () => undefined
  }
  Object.assign(Animated, {
    loop: () => animation,
    sequence: () => animation,
    delay: (ms: number) => {
      delays.push(ms)
      return animation
    },
    timing: (
      _value: unknown,
      options: { toValue: unknown; duration?: number }
    ) => {
      timings.push(options)
      return animation
    }
  })
  AccessibilityInfo.isReduceMotionEnabled = async () => false
  AccessibilityInfo.addEventListener = ((
    _name: string,
    listener: (value: boolean) => void
  ) => {
    reducedChanged = listener
    return { remove: () => undefined }
  }) as typeof AccessibilityInfo.addEventListener
}
async function render(
  text = 'A long scoring description',
  enabled = true
): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <UndoTicker
        text={text}
        enabled={enabled}
        style={{ fontSize: 12 }}
        testID="ticker"
      />
    )
  })
}
async function measure(width: number, content: number): Promise<void> {
  const viewport = host.querySelector<HTMLElement>(
    '[data-testid="ticker-viewport"]'
  )!
  const inner = host.querySelector<HTMLElement>(
    '[data-testid="ticker-motion"]'
  )!.parentElement!
  for (const [node, value] of [
    [viewport, width],
    [inner, content]
  ] as const) {
    node.getBoundingClientRect = () => new window.DOMRect(0, 0, value, 16)
    await act(async () => {
      ;(
        node as HTMLElement & { __reactLayoutHandler: (event: unknown) => void }
      ).__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: value, height: 16 } }
      })
      await new Promise(resolve => setTimeout(resolve, 5))
    })
  }
}
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  Object.assign(Animated, {
    loop: original.loop,
    sequence: original.sequence,
    timing: original.timing,
    delay: original.delay
  })
  AccessibilityInfo.isReduceMotionEnabled = original.query
  AccessibilityInfo.addEventListener = original.subscribe
})
describe('undo ticker', () => {
  it('animates measured overflow with an end hold and immediate left reset', async () => {
    mock()
    await render()
    await measure(100, 220)
    expect(starts).equals(1)
    expect(delays).deep.equals([1000, 2000])
    expect(
      timings.map(({ toValue, duration }) => [toValue, duration])
    ).deep.equals([
      [-120, 5000],
      [0, 0]
    ])
    expect(host.textContent).equals('A long scoring description')
  })
  it('stays still when text fits and stops on resize, expanded history, new text and reduced motion', async () => {
    mock()
    await render()
    await measure(220, 100)
    expect(starts).equals(0)
    await measure(100, 220)
    expect(starts).greaterThan(0)
    let prior = stops
    await render('A new description')
    expect(stops).greaterThan(prior)
    prior = stops
    await render('A new description', false)
    expect(stops).greaterThan(prior)
    const paused = starts
    await measure(90, 240)
    expect(starts).equals(paused)
    await render('A new description', true)
    prior = stops
    await act(async () => {
      reducedChanged(true)
    })
    expect(stops).greaterThan(prior)
    const reducedStarts = starts
    await measure(80, 250)
    expect(starts).equals(reducedStarts)
    await act(async () => {
      reducedChanged(false)
    })
    expect(starts).greaterThan(reducedStarts)
    prior = stops
    await measure(300, 250)
    expect(stops).greaterThan(prior)
  })
  it('stops the active loop when its control unmounts', async () => {
    mock()
    await render()
    await measure(100, 220)
    expect(starts).equals(1)
    await act(async () => {
      root!.unmount()
      root = undefined
    })
    expect(stops).equals(1)
  })
})
