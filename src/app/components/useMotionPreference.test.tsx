/* eslint-disable @typescript-eslint/unbound-method -- Preserve and restore API functions in the test harness. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo } from 'react-native'

import { GuidanceDetail } from '../scoring/GuidanceDetail'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { useMotionPreference } from './useMotionPreference'

const query = AccessibilityInfo.isReduceMotionEnabled
const subscribe = AccessibilityInfo.addEventListener
let root: Root | undefined
let host: HTMLDivElement
let changed: (value: boolean) => void
let removed = 0
async function mount(view: React.ReactElement): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{view}</ThemeProvider>)
  })
}
function observe(): void {
  removed = 0
  AccessibilityInfo.addEventListener = (_name, listener) => {
    changed = listener as (value: boolean) => void
    return {
      remove: () => {
        removed++
      }
    }
  }
}
function Probe(): React.ReactElement {
  return <span>{String(useMotionPreference())}</span>
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    changeTheme(tsBallpark)
  })
  root = undefined
  AccessibilityInfo.isReduceMotionEnabled = query
  AccessibilityInfo.addEventListener = subscribe
})
describe('live motion preference and guidance shadow', () => {
  it('honors the initial setting and later events without a stale initial response winning', async () => {
    observe()
    let resolve!: (value: boolean) => void
    AccessibilityInfo.isReduceMotionEnabled = async () =>
      await new Promise(_resolve => {
        resolve = _resolve
      })
    await mount(<Probe />)
    expect(host.textContent).equals('true')
    await act(async () => {
      changed(false)
      resolve(true)
    })
    expect(host.textContent).equals('false')
    await act(async () => {
      changed(true)
    })
    expect(host.textContent).equals('true')
  })
  it('allows motion after a failed query and ignores a result after unmount', async () => {
    observe()
    AccessibilityInfo.isReduceMotionEnabled = async () => {
      throw new Error('Unavailable')
    }
    await mount(<Probe />)
    expect(host.textContent).equals('false')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(removed).equals(1)
    let resolve!: (value: boolean) => void
    AccessibilityInfo.isReduceMotionEnabled = async () =>
      await new Promise(_resolve => {
        resolve = _resolve
      })
    await mount(<Probe />)
    await act(async () => {
      root!.unmount()
      resolve(false)
    })
    root = undefined
    expect(removed).equals(2)
  })
  it('keeps yellow bold foreground text while pulsing only the hidden shadow and stops on preference changes', async function () {
    this.timeout(5000)
    observe()
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    for (const theme of [tsBallpark, tsDark]) {
      await act(async () => {
        changeTheme(theme)
      })
      await mount(
        <GuidanceDetail label="Ball trajectory" value="45° Fly Ball" />
      )
      const foreground = host.querySelector<HTMLElement>(
        '[data-testid="Ball trajectory value"]'
      )!
      const shadow = host.querySelector<HTMLElement>(
        '[data-testid="Ball trajectory shadow"]'
      )!
      expect(foreground.style.color).equals('rgb(241, 207, 85)')
      expect(foreground.style.fontWeight).equals('700')
      expect(foreground.style.opacity).equals('')
      expect(shadow.getAttribute('aria-hidden')).equals('true')
      expect(shadow.style.color).equals('rgba(0, 0, 0, 0)')
      expect(shadow.style.textShadow).includes('8px')
      await act(async () => {
        changed(true)
      })
      expect(Number(shadow.style.opacity)).equals(0)
      await mount(
        <GuidanceDetail label="Home run type" value="In-the-park Home Run" />
      )
      expect(
        host.querySelector('[aria-label="Home run type: In-the-park Home Run"]')
      ).not.equals(null)
      await act(async () => {
        changed(false)
      })
    }
  })
})
