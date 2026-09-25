/* eslint-disable @typescript-eslint/unbound-method -- Retain accessibility functions for restoration. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo } from 'react-native'

import { RosterSelector } from '../scoring/RosterSelector'
import { SwitchHitterHint } from '../scoring/SwitchHitterHint'
import { ThemeProvider } from '../theme/ThemeContext'
import { LivePill } from './LivePill'

const query = AccessibilityInfo.isReduceMotionEnabled
const subscribe = AccessibilityInfo.addEventListener
let root: Root | undefined
let host: HTMLDivElement
const listeners = new Set<(value: boolean) => void>()
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
async function render(
  view: React.ReactElement,
  reduced = false
): Promise<void> {
  AccessibilityInfo.isReduceMotionEnabled = async () => reduced
  AccessibilityInfo.addEventListener = (_name, fn) => {
    const listener = fn as (value: boolean) => void
    listeners.add(listener)
    return {
      remove: () => {
        listeners.delete(listener)
      }
    }
  }
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{view}</ThemeProvider>)
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  AccessibilityInfo.isReduceMotionEnabled = query
  AccessibilityInfo.addEventListener = subscribe
  expect(listeners.size).equals(0)
})
describe('Reanimated UI components', () => {
  it('keeps Live and switch-hitter pulses readable and honors live reduced-motion changes and dismissal', async () => {
    let dismissed = 0
    await render(
      <>
        <LivePill />
        <LivePill inline />
        <SwitchHitterHint
          onDismiss={() => {
            dismissed++
          }}
        />
      </>
    )
    const live = host.querySelector<HTMLElement>('[aria-label="Live now"]')!
    const hint = host.querySelector<HTMLElement>(
      '[aria-label="Drag to the other batter box"]'
    )!
    await act(async () => {
      await delay(60)
      listeners.forEach(fn => {
        fn(true)
      })
    })
    expect(live.style.opacity).equals('1')
    expect(hint.style.opacity).equals('1')
    await act(async () => {
      listeners.forEach(fn => {
        fn(false)
      })
      await delay(30)
    })
    await act(async () => {
      host.querySelector<HTMLElement>('[aria-label="OK"]')!.click()
    })
    expect(dismissed).equals(1)
  })
  it('settles roster thumbs after programmatic selection and width changes with reduced motion', async () => {
    const draw = async (value: number): Promise<void> => {
      await render(
        <RosterSelector
          labels={['L', 'S', 'R']}
          value={value}
          onChange={() => undefined}
        />,
        true
      )
    }
    await draw(0)
    const thumb = host.querySelector<HTMLElement>(
      '[data-testid="Roster selector thumb"]'
    )!
    const track = thumb.parentElement as HTMLElement & {
      __reactLayoutHandler: (event: {
        nativeEvent: {
          layout: { width: number; height: number; x: number; y: number }
        }
      }) => void
    }
    const layout = async (width: number): Promise<void> => {
      await act(async () => {
        track.__reactLayoutHandler({
          nativeEvent: { layout: { width, height: 40, x: 0, y: 0 } }
        })
      })
      await act(async () => {
        await delay(80)
      })
    }
    await layout(300)
    await draw(2)
    await act(async () => {
      await delay(80)
    })
    expect(thumb.style.left).equals('200px')
    await layout(240)
    expect(thumb.style.left).equals('160px')
    await draw(1)
    await act(async () => {
      await delay(80)
    })
    expect(thumb.style.left).equals('80px')
    await act(async () => {
      listeners.forEach(fn => {
        fn(false)
      })
    })
    await draw(0)
    await act(async () => {
      await delay(220)
    })
    expect(thumb.style.left).equals('0px')
  })
})
