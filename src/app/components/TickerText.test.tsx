/* eslint-disable @typescript-eslint/unbound-method -- Save and restore test doubles without invoking unbound methods. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, Animated, Platform } from 'react-native'

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
  it('sizes its box to the line from the first frame, and widens the line to its full width only to pan it', async () => {
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    Object.assign(Animated, {
      loop: () => ({
        start: () => undefined,
        stop: () => undefined,
        reset: () => undefined
      })
    })
    await render('Christian Encarnacion-Strand #1')
    const box = document.querySelector<HTMLElement>(
      '[data-testid="ticker-text"]'
    )!
    const content = document.querySelector<HTMLElement>(
      '[data-testid="ticker-text-content"]'
    )!
    const line = (): CSSStyleDeclaration =>
      getComputedStyle(content.parentElement!)
    // Nothing wider than the line itself sets the box's width, and the web
    // keeps one copy of the text.
    expect(box.style.width).equals('')
    expect(line().width).not.equals('10000px')
    expect(box.textContent).equals('Christian Encarnacion-Strand #1')
    await act(async () => {
      layout('ticker-text', 120)
      layout('ticker-text-content', 240)
    })
    expect(line().width).equals('240px')
  })

  it('cuts a line too long for its box with an ellipsis while it does not pan, and reads it again when it changes', async () => {
    let changed = (_value: boolean): void => undefined
    AccessibilityInfo.isReduceMotionEnabled = async () => true
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
    await render('Christian Encarnacion-Strand #1')
    const content = (): HTMLElement =>
      document.querySelector<HTMLElement>(
        '[data-testid="ticker-text-content"]'
      )!
    await act(async () => {
      layout('ticker-text', 120)
      layout('ticker-text-content', 240)
    })
    // Reduce Motion: no pan; the line stays in its box and ends in an
    // ellipsis.
    expect(starts).equals(0)
    expect(content().parentElement!.style.width).equals('')
    expect(getComputedStyle(content()).textOverflow).equals('ellipsis')
    // Still read while cut: a line that now fits does not pan once motion
    // is allowed.
    await act(async () => {
      layout('ticker-text-content', 100)
    })
    await act(async () => {
      changed(false)
    })
    expect(starts).equals(0)
  })

  it('reads a phone’s line from an unseen copy on a strip wider than any name, and pans it that wide', async () => {
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    Object.assign(Animated, {
      loop: () => ({
        start: () => undefined,
        stop: () => undefined,
        reset: () => undefined
      })
    })
    const os = Platform.OS
    Object.assign(Platform, { OS: 'ios' })
    try {
      await render('Christian Encarnacion-Strand #1')
      const measure = document.querySelector<HTMLElement>(
        '[data-testid="ticker-text-measure"]'
      )!
      const strip = getComputedStyle(measure.parentElement!)
      expect(strip.position).equals('absolute')
      expect(strip.width).equals('10000px')
      expect(strip.opacity).equals('0')
      await act(async () => {
        layout('ticker-text', 120)
        layout('ticker-text-measure', 240)
      })
      expect(
        document.querySelector<HTMLElement>(
          '[data-testid="ticker-text-content"]'
        )!.parentElement!.style.width
      ).equals('240px')
    } finally {
      Object.assign(Platform, { OS: os })
    }
  })

  it('pans a browser’s line its whole width, fractions rounded up, and reads a new line with no layout', async () => {
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    Object.assign(Animated, {
      loop: () => ({
        start: () => undefined,
        stop: () => undefined,
        reset: () => undefined
      })
    })
    // The text's own extent, as a browser lays it out.
    let extent = 225.125
    const createRange = document.createRange.bind(document)
    document.createRange = () =>
      ({
        selectNodeContents: () => undefined,
        getBoundingClientRect: () => ({ width: extent })
      }) as unknown as Range
    try {
      await render('Christian Encarnacion-Strand #44')
      const line = (): string =>
        document.querySelector<HTMLElement>(
          '[data-testid="ticker-text-content"]'
        )!.parentElement!.style.width
      await act(async () => {
        layout('ticker-text', 120)
      })
      expect(line()).equals('226px')
      // A longer name in the same box: no layout event, read all the same.
      extent = 300.4
      await render('Christian Encarnacion-Strand Jr. #44')
      expect(line()).equals('301px')
    } finally {
      document.createRange = createRange
    }
  })

  it('reads a browser’s line again when a web font arrives, with no render', async () => {
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    Object.assign(Animated, {
      loop: () => ({
        start: () => undefined,
        stop: () => undefined,
        reset: () => undefined
      })
    })
    let extent = 200.2
    const createRange = document.createRange.bind(document)
    document.createRange = () =>
      ({
        selectNodeContents: () => undefined,
        getBoundingClientRect: () => ({ width: extent })
      }) as unknown as Range
    const listeners: Array<() => void> = []
    const fonts = {
      ready: new Promise<void>(() => undefined),
      addEventListener: (_type: string, listener: () => void) => {
        listeners.push(listener)
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.splice(listeners.indexOf(listener), 1)
      }
    }
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: fonts
    })
    try {
      await render('Christian Encarnacion-Strand #44')
      await act(async () => {
        layout('ticker-text', 120)
      })
      const line = (): string =>
        document.querySelector<HTMLElement>(
          '[data-testid="ticker-text-content"]'
        )!.parentElement!.style.width
      expect(line()).equals('201px')
      // The real face is wider than the fallback the line was first set in.
      extent = 231.6
      await act(async () => {
        for (const listener of [...listeners]) listener()
      })
      expect(line()).equals('232px')
      await act(async () => {
        root!.unmount()
      })
      root = undefined
      expect(listeners).has.length(0)
    } finally {
      document.createRange = createRange
      Reflect.deleteProperty(document, 'fonts')
    }
  })

  it('makes its text unselectable only when told to', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const content = (): HTMLElement =>
      document.querySelector<HTMLElement>(
        '[data-testid="ticker-text-content"]'
      )!
    await act(async () => {
      root!.render(<TickerText>Babe Ruth #3</TickerText>)
    })
    expect(getComputedStyle(content()).userSelect).not.equals('none')
    await act(async () => {
      root!.render(<TickerText selectable={false}>Babe Ruth #3</TickerText>)
    })
    expect(getComputedStyle(content()).userSelect).equals('none')
  })
})
