import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { NAV_CLEARANCE_REM } from './AppNav'
import { SuccessToast } from './SuccessToast'

let root: Root | undefined
let restoreTimers: (() => void) | undefined
let restoreWidth: (() => void) | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  restoreTimers?.()
  restoreTimers = undefined
  restoreWidth?.()
  restoreWidth = undefined
  document.body.replaceChildren()
})

function controlledDismissals(): Array<{
  fire: () => void
  canceled: boolean
}> {
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timers: Array<{
    fire: () => void
    canceled: boolean
    handle: ReturnType<typeof setTimeout>
  }> = []
  globalThis.setTimeout = ((
    callback: () => void,
    delay: number,
    ...args: unknown[]
  ) => {
    if (delay !== 5000) return originalSet(callback, delay, ...args)
    const handle = originalSet(() => undefined, 60000)
    timers.push({ fire: callback, canceled: false, handle })
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const timer = timers.find(timer => timer.handle === handle)
    if (timer != null) timer.canceled = true
    originalClear(handle)
  }) as typeof clearTimeout
  restoreTimers = () => {
    for (const timer of timers) originalClear(timer.handle)
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  }
  return timers
}

describe('success confirmation toast', () => {
  it('clears floating navigation on a phone and keeps desktop confirmation near the bottom', async () => {
    controlledDismissals()
    const old = Object.getOwnPropertyDescriptor(
      document.documentElement,
      'clientWidth'
    )
    restoreWidth = () => {
      if (old != null)
        Object.defineProperty(document.documentElement, 'clientWidth', old)
      else
        delete (document.documentElement as unknown as Record<string, unknown>)
          .clientWidth
      window.dispatchEvent(new window.Event('resize'))
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const show = async (width: number): Promise<HTMLElement> => {
      await act(async () => {
        Object.defineProperty(document.documentElement, 'clientWidth', {
          configurable: true,
          get: () => width
        })
        window.dispatchEvent(new window.Event('resize'))
        root!.render(
          <ThemeProvider>
            <SuccessToast
              notice={{ id: width, message: 'Game changes saved' }}
            />
          </ThemeProvider>
        )
      })
      return [...host.querySelectorAll<HTMLElement>('div')].find(
        node => getComputedStyle(node).position === 'absolute'
      )!
    }
    const phone = await show(390)
    expect(getComputedStyle(phone).bottom).equals(
      `${tsBallpark.rem(NAV_CLEARANCE_REM - 1)}px`
    )
    const desktop = await show(1440)
    expect(getComputedStyle(desktop).bottom).equals(`${tsBallpark.rem(2)}px`)
  })
  it('restarts the full dismissal window when a success arrives during the old fade', async () => {
    const timers = controlledDismissals()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const show = async (id: number, message: string): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <SuccessToast notice={{ id, message }} />
          </ThemeProvider>
        )
      })
    }
    await show(1, 'Game changes saved')
    expect(timers).length(1)
    await act(async () => {
      timers[0].fire()
    })
    await show(2, 'Game proposal sent')
    expect(timers[0].canceled).equals(true)
    expect(timers).length(2)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 350))
    })
    expect(document.querySelector('[role="alert"]')!.textContent).equals(
      'Game proposal sent'
    )
    await act(async () => {
      timers[1].fire()
      await new Promise(resolve => setTimeout(resolve, 350))
    })
    expect(document.querySelector('[role="alert"]')).equals(null)
  })

  it('cancels the current dismissal timer when its shell unmounts', async () => {
    const timers = controlledDismissals()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SuccessToast notice={{ id: 1, message: 'Game changes saved' }} />
        </ThemeProvider>
      )
    })
    expect(timers).length(1)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(timers[0].canceled).equals(true)
  })
  it('announces white text on blue glass and fades after five seconds', async function () {
    this.timeout(8000)
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SuccessToast notice={{ id: 1, message: 'Game changes saved' }} />
        </ThemeProvider>
      )
    })
    const text = document.querySelector<HTMLElement>('[role="alert"]')!
    expect(text.textContent).equals('Game changes saved')
    expect(window.getComputedStyle(text).color).equals('rgb(255, 255, 255)')
    expect(window.getComputedStyle(text.parentElement!).backgroundColor).equals(
      'rgba(23, 105, 210, 0.82)'
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5400))
    })
    expect(document.querySelector('[role="alert"]')).equals(null)
  })
  it('updates a repeated success and clears its timer when hidden', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SuccessToast notice={{ id: 1, message: 'Game changes saved' }} />
        </ThemeProvider>
      )
    })
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SuccessToast notice={{ id: 2, message: 'Game proposal sent' }} />
        </ThemeProvider>
      )
    })
    expect(document.querySelector('[role="alert"]')!.textContent).equals(
      'Game proposal sent'
    )
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SuccessToast />
        </ThemeProvider>
      )
    })
    expect(document.querySelector('[role="alert"]')).equals(null)
  })
})
