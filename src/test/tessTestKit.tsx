import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../app/theme/ThemeContext'

/**
 * What the Tess component tests share: a themed render into the document,
 * and a clock for the long timers that a test steps through by hand.
 */
let root: Root | undefined

export async function render(
  element: React.ReactElement
): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

export async function rerender(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}

export async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
}

export function byLabel(label: string): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(
    `[aria-label="${label}"]`
  )
  if (found == null) throw new Error(`Nothing labelled ${label}`)
  return found
}

export function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

export async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
  })
}

/** Lets pending promises and the renders they cause finish. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

export interface ManualClock {
  /** Moves time on, running every long timer that falls due. */
  advance: (ms: number) => Promise<void>
  /** Long timers waiting to run. */
  pending: () => number[]
  restore: () => void
}

/**
 * Takes over timers of at least `fromMs`, leaving the short ones React and
 * react-native-web use to the real clock: a press starts 50 ms after the
 * pointer goes down, and the long-press timer runs at 500.
 */
export function manualClock(fromMs = 600): ManualClock {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  globalThis.setTimeout = ((run: () => void, ms = 0, ...args: unknown[]) => {
    if (ms < fromMs) return realSet(run, ms, ...args)
    const id = next++
    timers.set(id, { at: now + ms, run })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    if (typeof id === 'number' && timers.delete(id)) return
    realClear(id)
  }) as typeof clearTimeout
  return {
    advance: async ms => {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (due == null) break
        timers.delete(due[0])
        now = due[1].at
        await act(async () => {
          due[1].run()
        })
      }
      now = until
    },
    pending: () => [...timers.values()].map(timer => timer.at - now),
    restore: () => {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  }
}

/**
 * The window's size as React Native reads it in a browser, until `restore`:
 * the document's client box, and a resize to tell the listeners.
 */
export async function windowSize(
  width: number,
  height = 900
): Promise<{ restore: () => Promise<void> }> {
  const html = document.documentElement
  const saved = ['clientWidth', 'clientHeight'].map(
    key => [key, Object.getOwnPropertyDescriptor(html, key)] as const
  )
  Object.defineProperty(html, 'clientWidth', {
    configurable: true,
    value: width
  })
  Object.defineProperty(html, 'clientHeight', {
    configurable: true,
    value: height
  })
  await act(async () => {
    window.dispatchEvent(new window.Event('resize'))
  })
  return {
    restore: async () => {
      // The document's own box lives on the prototype: taking the
      // instance's property away shows it again.
      for (const [key, descriptor] of saved)
        if (descriptor == null) Reflect.deleteProperty(html, key)
        else Object.defineProperty(html, key, descriptor)
      await act(async () => {
        window.dispatchEvent(new window.Event('resize'))
      })
    }
  }
}
