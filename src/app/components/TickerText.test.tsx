/* eslint-disable @typescript-eslint/unbound-method -- Save and restore test doubles without invoking unbound methods. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, Animated } from 'react-native'

import { TickerText } from './TickerText'

let root: Root | undefined
const reduce = AccessibilityInfo.isReduceMotionEnabled
const subscribe = AccessibilityInfo.addEventListener
const loop = Animated.loop
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  AccessibilityInfo.isReduceMotionEnabled = reduce
  AccessibilityInfo.addEventListener = subscribe
  Object.assign(Animated, { loop })
  document.body.replaceChildren()
})
function layout(id: string, width: number): void {
  const node = document.querySelector(`[data-testid="${id}"]`)!
  let fiber = (node as any)[
    Object.keys(node).find(k => k.startsWith('__reactFiber'))!
  ]
  while (fiber != null) {
    if (fiber.memoizedProps?.onLayout != null) {
      fiber.memoizedProps.onLayout({ nativeEvent: { layout: { width } } })
      return
    }
    fiber = fiber.return
  }
  throw new Error('No layout handler')
}
async function render(text = 'Long umpire name'): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<TickerText style={{ fontSize: 12 }}>{text}</TickerText>)
  })
}
describe('TickerText', () => {
  it('animates only overflow, restarts on text/size changes, and cleans up motion listeners', async () => {
    let changed = (_value: boolean): void => undefined
    let removed = 0
    let starts = 0
    let stops = 0
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    AccessibilityInfo.addEventListener = ((
      _event: string,
      callback: (value: boolean) => void
    ) => {
      changed = callback
      return {
        remove: () => {
          removed++
        }
      }
    }) as typeof subscribe
    Object.assign(Animated, {
      loop: () => ({
        start: () => {
          starts++
        },
        stop: () => {
          stops++
        },
        reset: () => undefined
      })
    })
    await render()
    expect(
      document
        .querySelector('[data-testid="ticker-text"]')!
        .getAttribute('aria-label')
    ).equals('Long umpire name')
    expect(starts).equals(0)
    await act(async () => {
      layout('ticker-text', 100)
      layout('ticker-text-content', 90)
    })
    expect(starts).equals(0)
    await act(async () => {
      layout('ticker-text-content', 200)
    })
    expect(starts).equals(1)
    await render('Another long name')
    expect(starts).equals(2)
    expect(stops).equals(1)
    await act(async () => {
      changed(true)
    })
    expect(stops).equals(2)
    await act(async () => {
      changed(false)
    })
    expect(starts).equals(3)
    await act(async () => {
      layout('ticker-text', 300)
    })
    expect(stops).equals(3)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(removed).equals(1)
  })
  it('does not let a late initial motion read override a change or update an unmounted label', async () => {
    let resolve!: (value: boolean) => void
    let changed!: (value: boolean) => void
    AccessibilityInfo.isReduceMotionEnabled = async () =>
      await new Promise<boolean>(_resolve => {
        resolve = _resolve
      })
    AccessibilityInfo.addEventListener = ((
      _event: string,
      callback: (value: boolean) => void
    ) => {
      changed = callback
      return { remove: () => undefined }
    }) as typeof subscribe
    let starts = 0
    Object.assign(Animated, {
      loop: () => ({
        start: () => {
          starts++
        },
        stop: () => undefined,
        reset: () => undefined
      })
    })
    await render()
    await act(async () => {
      layout('ticker-text', 100)
      layout('ticker-text-content', 200)
      changed(true)
      resolve(false)
    })
    expect(starts).equals(0)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    await render()
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    await act(async () => {
      resolve(false)
    })
    AccessibilityInfo.isReduceMotionEnabled = async () => {
      throw new Error('Unavailable')
    }
    await render()
    expect(starts).equals(0)
  })
})
